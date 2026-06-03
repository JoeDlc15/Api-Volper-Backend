require('dotenv').config();
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const jar = new CookieJar();
const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    baseURL: 'https://volperseal.goldensystem.com.pe'
}));

async function extraerCotizacion(quotationNumber) {
    try {
        console.log(`--- 🕵️ Obteniendo página de login ---`);
        const loginPage = await client.get('/login');
        const $ = cheerio.load(loginPage.data);
        const csrfToken = $('input[name="_token"]').val();
        if (!csrfToken) throw new Error("No se pudo extraer el Token CSRF.");

        const email = process.env.API_EMAIL;
        const password = process.env.API_PASSWORD;

        if (!email || !password) {
            throw new Error("Las credenciales (API_EMAIL, API_PASSWORD) no están definidas.");
        }

        console.log("--- 🔑 Autenticando en Volper Seal ---");
        const loginResponse = await client.post('/login', new URLSearchParams({
            '_token': csrfToken,
            'email': email,
            'password': password
        }));

        const finalUrl = loginResponse.request.res ? loginResponse.request.res.responseUrl : loginResponse.request.path;
        if (finalUrl && finalUrl.endsWith('/login')) {
             throw new Error("Credenciales invalidas");
        }
        console.log("✅ Sesión iniciada.");

        console.log(`--- 📥 Extrayendo cotización ${quotationNumber} ---`);
        const response = await client.get(`/quotations/record/${quotationNumber}`);
        
        // Verifica si la API devolvió HTML por falta de permisos o si los datos no existen
        if (typeof response.data === 'string' && response.data.includes('<html')) {
            throw new Error("El usuario no tiene permisos para ver esta cotización o fue denegado.");
        }

        const data = response.data.data;
        if (!data || !data.number_full) {
             throw new Error("Cotización no encontrada o no hay datos.");
        }

        let documentRef = null;
        let finalStatus = "PENDIENTE";

        console.log(`Estado: ${finalStatus}. Guardando en base de datos...`);
        
        const sellerName = data.quotation.user ? data.quotation.user.name : null;
        const descriptionVal = data.quotation.description || null;

        const customerRuc = data.quotation.customer ? data.quotation.customer.number : null;

        await prisma.quotation.upsert({
            where: { number: data.number_full },
            update: {
                status: finalStatus,
                documentRef: documentRef,
                sellerName: sellerName,
                description: descriptionVal,
                customerRuc: customerRuc
            },
            create: {
                number: data.number_full,
                date: data.date_of_issue,
                time: data.quotation.time_of_issue,
                customerName: data.quotation.customer.name || "Sin Nombre",
                customerRuc: customerRuc,
                address: data.quotation.customer.address || "Sin Dirección",
                status: finalStatus,
                documentRef: documentRef,
                sellerName: sellerName,
                description: descriptionVal,
                items: {
                    create: data.quotation.items.map(line => ({
                        productId: line.item.internal_id,
                        description: line.item.description,
                        quantity: parseFloat(line.quantity),
                        stockSystem: parseFloat(line.item.stock)
                    }))
                }
            }
        });

        console.log(`✅ ¡Éxito! Cotización ${data.number_full} agregada correctamente.`);
    } catch (error) {
        console.error(`❌ Error en la extracción: ${error.message}`);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

const nro = process.argv[2];
if (!nro) {
    console.error("❌ Debes proporcionar un número de cotización como argumento.");
    process.exit(1);
}

extraerCotizacion(nro);
