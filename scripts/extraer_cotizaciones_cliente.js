require('dotenv').config();
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const progressPath = path.join(__dirname, 'import_progress.json');
const outputPath = path.join(__dirname, '../data/customer_quotations.json');
const credPath = path.join(__dirname, '../credentials.json');

function writeProgress(progress) {
    fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
}

function getSavedCredentials() {
    if (fs.existsSync(credPath)) {
        try {
            return JSON.parse(fs.readFileSync(credPath, 'utf8'));
        } catch (e) {
            console.error("Error reading credentials.json:", e);
        }
    }
    return {};
}

const jar = new CookieJar();
const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    baseURL: 'https://volperseal.goldensystem.com.pe'
}));

async function run(query) {
    try {
        writeProgress({ status: "running", current: 0, total: 0, currentQuotation: "", message: "🕵️ Iniciando sesión en Volper Seal..." });

        const creds = getSavedCredentials();
        const email = process.env.API_EMAIL || creds.ventasEmail;
        const password = process.env.API_PASSWORD || creds.ventasPassword;

        if (!email || !password) {
            throw new Error("No hay credenciales configuradas.");
        }

        const loginPage = await client.get('/login');
        const $ = cheerio.load(loginPage.data);
        const csrfToken = $('input[name="_token"]').val();
        if (!csrfToken) throw new Error("No se pudo obtener el CSRF Token.");

        const loginResponse = await client.post('/login', new URLSearchParams({
            '_token': csrfToken,
            'email': email,
            'password': password
        }));

        const finalUrl = loginResponse.request.res ? loginResponse.request.res.responseUrl : loginResponse.request.path;
        if (finalUrl && finalUrl.endsWith('/login')) {
            throw new Error("Credenciales inválidas.");
        }

        writeProgress({ status: "running", current: 0, total: 0, currentQuotation: "", message: `🔍 Buscando cotizaciones del cliente: ${query}...` });

        // Obtener cotizaciones del cliente (soportando paginación si hubiere más)
        let page = 1;
        let lastPage = 1;
        let allQuotations = [];

        do {
            const url = `/quotations/records?column=customer&form=%7B%22week%22%3Anull%2C%22month%22%3Anull%2C%22d_start%22%3Anull%2C%22d_end%22%3Anull%2C%22period%22%3A%22month%22%2C%22date_start%22%3Anull%2C%22date_end%22%3Anull%2C%22state_type_id%22%3Anull%7D&page=${page}&value=${encodeURIComponent(query)}`;
            const response = await client.get(url);

            if (typeof response.data === 'string' && response.data.includes('<html')) {
                throw new Error("Sesión expirada o denegada en búsqueda.");
            }

            const data = response.data.data;
            if (data && data.length > 0) {
                allQuotations = allQuotations.concat(data);
            }

            lastPage = response.data.meta ? response.data.meta.last_page : 1;
            page++;
        } while (page <= lastPage);

        const totalQuotations = allQuotations.length;
        if (totalQuotations === 0) {
            writeProgress({ status: "done", message: `⚠️ No se encontraron cotizaciones para "${query}".` });
            return;
        }

        writeProgress({ status: "running", current: 0, total: totalQuotations, currentQuotation: "", message: `📥 Encontradas ${totalQuotations} cotizaciones. Extrayendo ítems secuencialmente...` });

        // Cargar archivo existente para verificar qué cotizaciones ya tenemos
        let existingRecords = [];
        let existingQuoteNumbers = new Set();
        if (fs.existsSync(outputPath)) {
            try {
                existingRecords = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
                existingRecords.forEach(r => {
                    if (r.number_full) existingQuoteNumbers.add(r.number_full);
                });
            } catch (e) {
                console.error("Error reading output file:", e);
            }
        }

        // Filtrar cotizaciones a descargar:
        // 1. Las que NO existen localmente.
        // 2. Las 2 más recientes que SÍ existen localmente (por si fueron modificadas).
        const quotesToFetch = [];
        let existingFetchedCount = 0;

        for (const quot of allQuotations) {
            if (!existingQuoteNumbers.has(quot.number_full)) {
                // Nueva cotización
                quotesToFetch.push(quot);
            } else {
                // Ya existe, pero descargamos las últimas 2 para actualizar cambios
                if (existingFetchedCount < 2) {
                    quotesToFetch.push(quot);
                    existingFetchedCount++;
                }
            }
        }

        const totalToFetch = quotesToFetch.length;
        if (totalToFetch === 0) {
            writeProgress({ status: "done", message: `✅ El historial de "${query}" ya está completamente actualizado.` });
            return;
        }

        writeProgress({ status: "running", current: 0, total: totalToFetch, currentQuotation: "", message: `📥 Se actualizarán/descargarán ${totalToFetch} cotizaciones recientes (omitiendo las ya guardadas).` });

        const newRecords = [];

        for (let i = 0; i < totalToFetch; i++) {
            const quot = quotesToFetch[i];
            const qNumber = quot.number_full;

            writeProgress({
                status: "running",
                current: i + 1,
                total: totalToFetch,
                currentQuotation: qNumber,
                message: `⏳ Descargando ítems de cotización ${qNumber} (${i + 1}/${totalToFetch})...`
            });

            // Respetar tiempo de espera seguro (3 segundos) para no saturar al servidor
            await new Promise(resolve => setTimeout(resolve, 3000));

            try {
                const detailResponse = await client.get(`/quotations/record/${quot.id}`);
                const detail = detailResponse.data.data;

                if (detail && detail.quotation && detail.quotation.items) {
                    let documentRef = "";
                    if (quot.documents && quot.documents.length > 0) {
                        documentRef = quot.documents[0].number_full;
                    } else if (quot.sale_notes && quot.sale_notes.length > 0) {
                        documentRef = quot.sale_notes[0].number_full;
                    } else if (detail.documents && detail.documents.length > 0) {
                        documentRef = detail.documents[0].number_full;
                    } else if (detail.sale_notes && detail.sale_notes.length > 0) {
                        documentRef = detail.sale_notes[0].number_full;
                    } else if (detail.quotation.documents && detail.quotation.documents.length > 0) {
                        documentRef = detail.quotation.documents[0].number_full;
                    } else if (detail.quotation.sale_notes && detail.quotation.sale_notes.length > 0) {
                        documentRef = detail.quotation.sale_notes[0].number_full;
                    }

                    const isBilled = documentRef ? true : false;

                    detail.quotation.items.forEach(line => {
                        const rec = {
                            customer_name: detail.quotation.customer.name || quot.customer_name,
                            customer_number: detail.quotation.customer.number || quot.customer_number,
                            number_full: detail.number_full,
                            date_of_issue: detail.date_of_issue,
                            internal_id: line.item.internal_id || "SIN-CODIGO",
                            item_description: line.item.description || "Sin descripción",
                            quantity: parseFloat(line.quantity) || 0,
                            sale_unit_price: parseFloat(line.item.sale_unit_price) || 0,
                            unit_price: parseFloat(line.unit_price) || 0,
                            total: parseFloat(line.total) || 0,
                            is_billed: isBilled,
                            document_ref: documentRef
                        };
                        newRecords.push(rec);
                    });
                }
            } catch (err) {
                console.error(`Error al extraer detalle de ${qNumber}:`, err.message);
                // Continuar con la siguiente cotización
            }
        }

        // Combinar y deduplicar: si ya existía la misma combinación (number_full, internal_id), sobrescribir
        const mergedMap = {};

        // Agregar registros anteriores
        existingRecords.forEach(r => {
            const key = `${r.number_full}-${r.internal_id}`;
            mergedMap[key] = r;
        });

        // Agregar nuevos registros (los más nuevos pisarán los viejos si se duplican)
        newRecords.forEach(r => {
            const key = `${r.number_full}-${r.internal_id}`;
            mergedMap[key] = r;
        });

        const mergedList = Object.values(mergedMap);

        // Guardar a disco
        fs.writeFileSync(outputPath, JSON.stringify(mergedList, null, 2));

        writeProgress({
            status: "done",
            message: `✅ Sincronización rápida completada. Se procesaron ${quotesToFetch.length} cotizaciones y se extrajeron ${newRecords.length} ítems.`
        });

    } catch (e) {
        console.error("Error general:", e.message);
        writeProgress({ status: "error", message: `❌ Error: ${e.message}` });
        process.exit(1);
    }
}

const queryArg = process.argv[2];
if (!queryArg) {
    console.error("Proporciona una consulta del cliente.");
    process.exit(1);
}

run(queryArg);
