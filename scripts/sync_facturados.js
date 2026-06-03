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

async function syncFacturados() {
    let updatedCount = 0;
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

        console.log(`--- 🔑 Iniciando sesión como ${email} ---`);
        const loginResponse = await client.post('/login', {
            _token: csrfToken,
            email: email,
            password: password
        }, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (loginResponse.request.res.responseUrl.includes('/login')) {
             throw new Error("Credenciales invalidas");
        }
        console.log("✅ Sesión iniciada.");

        // Visitar la página de cotizaciones primero para inicializar variables de sesión en el backend si las hay
        console.log("--- 🔄 Inicializando módulo de cotizaciones ---");
        await client.get('/quotations');

        // Buscar todas las cotizaciones que no estén facturadas
        const pendingQuotations = await prisma.quotation.findMany({
            where: {
                status: {
                    not: 'FACTURADO'
                }
            }
        });

        console.log(`🔍 Se encontraron ${pendingQuotations.length} cotizaciones pendientes/reservadas.`);

        for (const q of pendingQuotations) {
            try {
                const numberVal = q.number.split('-')[1]; // ej: 1532
                const formParam = encodeURIComponent(JSON.stringify({"week":null,"month":null,"d_start":null,"d_end":null,"period":"month","date_start":null,"date_end":null,"state_type_id":null}));
                const url = `/quotations/records?column=number&form=${formParam}&page=1&value=${numberVal}`;
                
                console.log(`➡️ Consultando Volper para ${q.number} ...`);
                const responseList = await client.get(url);
                
                if (responseList.data && responseList.data.data && responseList.data.data.length > 0) {
                    const listItem = responseList.data.data[0];
                    let documentRef = null;
                    
                    if (listItem.documents && listItem.documents.length > 0) {
                        documentRef = listItem.documents[0].number_full;
                    } else if (listItem.sale_notes && listItem.sale_notes.length > 0) {
                        documentRef = listItem.sale_notes[0].number_full;
                    }

                    if (documentRef) {
                        console.log(`✅ Cotización ${q.number} ya fue facturada: ${documentRef}. Actualizando base de datos...`);
                        await prisma.quotation.update({
                            where: { id: q.id },
                            data: {
                                status: 'FACTURADO',
                                documentRef: documentRef
                            }
                        });
                        updatedCount++;
                    }
                }
            } catch (err) {
                console.warn(`⚠️ Error al revisar cotización ${q.number}: ${err.message}`);
            }
        }

        console.log(`🎉 Sincronización completa. Cotizaciones actualizadas a FACTURADO: ${updatedCount}`);
    } catch (error) {
        console.error("❌ Error General:", error.message);
        throw error;
    } finally {
        await prisma.$disconnect();
    }
}

// Permitir correr desde consola
if (require.main === module) {
    syncFacturados().catch(e => process.exit(1));
}

module.exports = syncFacturados;
