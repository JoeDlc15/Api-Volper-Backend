require('dotenv').config();
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// 1. Configuramos el "Tarro de Cookies" para que la sesión se mantenga activa
const jar = new CookieJar();
const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    baseURL: 'https://volperseal.goldensystem.com.pe'
}));

async function iniciarMision() {
    try {
        console.log("--- 🕵️ Paso 1: Obteniendo página de login y Token CSRF ---");
        const loginPage = await client.get('/login');
        const $ = cheerio.load(loginPage.data);

        // Laravel siempre pone el token en un input oculto
        const csrfToken = $('input[name="_token"]').val();
        if (!csrfToken) throw new Error("No se pudo extraer el Token CSRF. Revisa la URL.");
        console.log("✅ Token obtenido:", csrfToken);

        const email = process.env.API_EMAIL;
        const password = process.env.API_PASSWORD;

        if (!email || !password) {
            throw new Error("Las credenciales (API_EMAIL, API_PASSWORD) no están definidas.");
        }

        console.log("--- 🔑 Paso 2: Autenticando en Volper Seal ---");
        const loginResponse = await client.post('/login', new URLSearchParams({
            '_token': csrfToken,
            'email': email,
            'password': password
        }));

        const finalUrl = loginResponse.request.res ? loginResponse.request.res.responseUrl : loginResponse.request.path;
        if (finalUrl && finalUrl.endsWith('/login')) {
             throw new Error("Credenciales invalidas");
        }
        console.log("✅ Sesión iniciada con éxito.");

        console.log("--- 🔄 Paso 3: Iniciando extracción masiva por almacenes (1 y 3) ---");

        let todosLosProductos = [];
        const warehouses = [1, 3];

        for (const whId of warehouses) {
            console.log(`\n--- 🔄 Iniciando extracción para almacén ID: ${whId} ---`);
            let paginaActual = 1;
            let hayMasPaginas = true;

            while (hayMasPaginas) {
                const url = `/inventory/report/records?active&brand_id&category_id&filter=01&page=${paginaActual}&warehouse_id=${whId}`;
                const response = await client.get(url);
                
                if (typeof response.data === 'string' && response.data.includes('<!DOCTYPE html>')) {
                    console.error(`⚠️ Alerta: El servidor de Volper redirigió a la página de Login en la página ${paginaActual}. La sesión expiró.`);
                    hayMasPaginas = false;
                    break;
                }

                const data = response.data.data;

                if (data && data.length > 0) {
                    // Forzar a que cada ítem guarde el warehouse_name correspondiente
                    data.forEach(item => {
                        item.warehouse_name = whId === 1 ? "Almacén - Almacén principal" : "Almacén - ALMACEN 2DO. PISO";
                    });

                    todosLosProductos = todosLosProductos.concat(data);
                    console.log(`📥 Almacén ${whId} - Página ${paginaActual} extraída (${todosLosProductos.length} productos acumulados)`);

                    const totalPaginas = response.data.meta.last_page;

                    if (paginaActual < totalPaginas) {
                        paginaActual++;
                        await new Promise(r => setTimeout(r, 600));
                    } else {
                        hayMasPaginas = false;
                    }
                } else {
                    hayMasPaginas = false;
                }
            }
        }

        console.log(`\n✅ ¡Misión completa! Total final: ${todosLosProductos.length} productos.`);

        // 4. Guardar TODO el array masivo en la raíz del proyecto
        const jsonPath = path.join(__dirname, '../data/product.json');
        fs.writeFileSync(jsonPath, JSON.stringify(todosLosProductos, null, 2));
        console.log("💾 Archivo 'product.json' actualizado con la base de datos completa.");
    } catch (error) {
        console.error("❌ Fallo en la extracción automática:", error.message);
        if (error.response) console.error("Respuesta del servidor:", error.response.status);
    }
}

iniciarMision();
