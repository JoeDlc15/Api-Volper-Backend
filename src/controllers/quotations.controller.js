const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getSavedCredentials } = require('../utils/credentials');

exports.addQuotation = (req, res) => {
    const { quotationNumber } = req.body;

    // Validar el formato
    if (!quotationNumber || !/^\d+$/.test(quotationNumber)) {
        return res.status(400).json({ success: false, error: "Número de cotización no válido." });
    }

    console.log(`🚀 Iniciando extracción de cotización ${quotationNumber}...`);

    const creds = getSavedCredentials();
    if (!creds.ventasEmail || !creds.ventasPassword) {
        return res.status(400).json({ success: false, error: "Faltan configurar las credenciales de Ventas/Administrador." });
    }

    const env = { ...process.env, API_EMAIL: creds.ventasEmail, API_PASSWORD: creds.ventasPassword };

    exec(`node scripts/extraer_cotizacion.js ${quotationNumber}`, { env }, (error, stdout, stderr) => {
        if (stdout) console.log(`[Script stdout]:\n${stdout}`);
        if (stderr) console.error(`[Script stderr]:\n${stderr}`);

        if (error) {
            console.error(`❌ Error: ${error.message}`);

            // Extraer el mensaje específico del error
            let userError = "Error interno al extraer la cotización o credenciales inválidas.";
            if (stdout.includes("El usuario no tiene permisos")) {
                userError = "No tienes permisos para ver esta cotización.";
            } else if (stdout.includes("Cotización no encontrada")) {
                userError = "La cotización no existe o no se puede acceder.";
            } else if (stdout.includes("Credenciales invalidas") || error.message.includes("Credenciales invalidas")) {
                userError = "Credenciales de Ventas/Administrador vencidas o incorrectas.";
            }

            return res.status(500).json({ success: false, error: userError });
        }
        res.json({ success: true, message: `Cotización ${quotationNumber} agregada correctamente.` });
    });
};

exports.getCustomerQuotations = (req, res) => {
    try {
        const filePath = path.join(__dirname, '../../data', 'customer_quotations.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return res.json(JSON.parse(data));
        }
        res.json([]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

exports.getImportCustomerProgress = (req, res) => {
    try {
        const filePath = path.join(__dirname, '../../scripts', 'import_progress.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return res.json(JSON.parse(data));
        }
        res.json({ status: "idle", message: "Listo para iniciar." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

exports.importCustomerQuotations = (req, res) => {
    const { query } = req.body;
    if (!query || query.trim() === "") {
        return res.status(400).json({ success: false, error: "Debes proporcionar un nombre o RUC de cliente." });
    }

    const creds = getSavedCredentials();
    if (!creds.ventasEmail || !creds.ventasPassword) {
        return res.status(400).json({ success: false, error: "Faltan configurar las credenciales de Ventas/Administrador." });
    }

    const progressPath = path.join(__dirname, '../../scripts', 'import_progress.json');
    fs.writeFileSync(progressPath, JSON.stringify({ status: "running", current: 0, total: 0, currentQuotation: "", message: "🕵️ Iniciando..." }, null, 2));

    const env = { ...process.env, API_EMAIL: creds.ventasEmail, API_PASSWORD: creds.ventasPassword };

    // Ejecutar en segundo plano asíncronamente
    exec(`node scripts/extraer_cotizaciones_cliente.js "${query}"`, { env }, (error, stdout, stderr) => {
        if (stdout) console.log(`[Customer Quotations Script stdout]:\n${stdout}`);
        if (stderr) console.error(`[Customer Quotations Script stderr]:\n${stderr}`);
        if (error) {
            console.error(`❌ Error en script de cotizaciones de cliente: ${error.message}`);
            fs.writeFileSync(progressPath, JSON.stringify({ status: "error", message: `❌ Error: ${error.message}` }, null, 2));
        }
    });

    res.json({ success: true, message: "Importación iniciada en segundo plano." });
};

exports.deleteCustomerQuotations = (req, res) => {
    const { customer_name } = req.body;
    const filePath = path.join(__dirname, 'data', 'customer_quotations.json');

    try {
        if (!fs.existsSync(filePath)) {
            return res.json({ success: true, message: "No hab├¡a registros para eliminar." });
        }

        if (customer_name) {
            // Eliminar solo las de ese cliente
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const filtered = data.filter(r => r.customer_name.toLowerCase() !== customer_name.toLowerCase());
            fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2));
            res.json({ success: true, message: `Registros de ${customer_name} eliminados correctamente.` });
        } else {
            // Eliminar archivo por completo
            fs.writeFileSync(filePath, JSON.stringify([], null, 2));
            res.json({ success: true, message: "Todos los registros por cliente se eliminaron." });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};
exports.createManualQuotation = async (req, res) => {
    try {
        const { customerName, items } = req.body;
        if (!customerName || !items || items.length === 0) {
            return res.status(400).json({ success: false, error: "Datos insuficientes para crear la cotización manual." });
        }

        // Generar un número de cotización correlativo para EXT (Extranjero)
        const lastExtQuot = await prisma.quotation.findFirst({
            where: { number: { startsWith: 'EXT-' } },
            orderBy: { id: 'desc' }
        });

        let nextNum = 1;
        if (lastExtQuot) {
            const parts = lastExtQuot.number.split('-');
            if (parts.length === 2) {
                nextNum = parseInt(parts[1]) + 1;
            }
        }
        
        const quotationNumber = `EXT-${String(nextNum).padStart(4, '0')}`;
        const today = new Date().toISOString().split('T')[0];

        const newQuot = await prisma.quotation.create({
            data: {
                number: quotationNumber,
                date: today,
                time: new Date().toTimeString().split(' ')[0],
                customerName: customerName,
                customerRuc: "-",
                address: "-",
                sellerName: "MANUAL",
                documentRef: "-",
                status: "PENDIENTE",
                items: {
                    create: items.map(item => ({
                        productId: item.productId,
                        description: item.description,
                        quantity: parseFloat(item.quantity) || 0,
                        stockSystem: 0
                    }))
                }
            }
        });

        res.json({ success: true, quotation: newQuot });
    } catch (error) {
        console.error("Error creando cotización manual:", error);
        res.status(500).json({ success: false, error: error.message });
    }
};


// Endpoint para revisar y extraer una cotizaci├│n individual de Volper Seal
exports.reviewQuotation = async (req, res) => {
    let number = req.params.number.trim();
    if (!number.startsWith('COT-')) {
        number = 'COT-' + number;
    }

    try {
        const creds = getSavedCredentials();
        const email = creds.ventasEmail;
        const password = creds.ventasPassword;

        if (!email || !password) {
            return res.status(400).json({ error: "Faltan configurar las credenciales de Ventas/Administrador." });
        }

        // Asegurar login con las credenciales de ventas
        await login(email, password);

        // Extraer la parte num├®rica para usarla directamente como ID (ej: "COT-1525" o "1525" -> "1525")
        const quotId = number.replace(/\D/g, '');
        if (!quotId) {
            return res.status(400).json({ error: "El formato de n├║mero de cotizaci├│n no es v├ílido." });
        }

        // Obtener el detalle de la cotizaci├│n directamente por su ID num├®rico
        const detailResponse = await client.get(`/quotations/record/${quotId}`);
        
        if (typeof detailResponse.data === 'string' && detailResponse.data.includes('<html')) {
            throw new Error("Sesi├│n expirada o denegada en Volper Seal.");
        }

        const detail = detailResponse.data.data;

        if (!detail || !detail.quotation) {
            return res.status(404).json({ error: `No se encontr├│ la cotizaci├│n ${number} en el servidor.` });
        }

        let documentRef = "";
        if (detail.documents && detail.documents.length > 0) {
            documentRef = detail.documents[0].number_full;
        } else if (detail.sale_notes && detail.sale_notes.length > 0) {
            documentRef = detail.sale_notes[0].number_full;
        } else if (detail.quotation && detail.quotation.documents && detail.quotation.documents.length > 0) {
            documentRef = detail.quotation.documents[0].number_full;
        } else if (detail.quotation && detail.quotation.sale_notes && detail.quotation.sale_notes.length > 0) {
            documentRef = detail.quotation.sale_notes[0].number_full;
        }

        const isBilled = documentRef ? true : false;

        const items = [];
        if (detail.quotation.items) {
            detail.quotation.items.forEach(line => {
                items.push({
                    customer_name: detail.quotation.customer.name || "Sin nombre",
                    customer_number: detail.quotation.customer.number || "Sin n├║mero",
                    number_full: detail.number_full,
                    date_of_issue: detail.date_of_issue,
                    internal_id: line.item.internal_id || "SIN-CODIGO",
                    item_description: line.item.description || "Sin descripci├│n",
                    quantity: parseFloat(line.quantity) || 0,
                    sale_unit_price: parseFloat(line.item.sale_unit_price) || 0,
                    unit_price: parseFloat(line.unit_price) || 0,
                    total: parseFloat(line.total) || 0,
                    is_billed: isBilled,
                    document_ref: documentRef
                });
            });
        }

        // Guardar as├¡ncronamente en customer_quotations.json para actualizar el historial local
        const filePath = path.join(__dirname, 'data', 'customer_quotations.json');
        let existingRecords = [];
        if (fs.existsSync(filePath)) {
            try {
                existingRecords = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {}
        }

        const mergedMap = {};
        existingRecords.forEach(r => {
            const key = `${r.number_full}-${r.internal_id}`;
            mergedMap[key] = r;
        });

        items.forEach(r => {
            const key = `${r.number_full}-${r.internal_id}`;
            mergedMap[key] = r;
        });

        fs.writeFileSync(filePath, JSON.stringify(Object.values(mergedMap), null, 2));

        res.json({
            success: true,
            number_full: detail.number_full,
            date_of_issue: detail.date_of_issue,
            customer_name: detail.quotation.customer.name,
            customer_number: detail.quotation.customer.number,
            items: items
        });

    } catch (e) {
        console.error("Error al revisar cotizaci├│n:", e.message);
        res.status(500).json({ error: e.message });
    }
};

// Obtener todas las cotizaciones (sin los items, para que sea rápido)
exports.getQuotations = async (req, res) => {
    try {
        const quotations = await prisma.quotation.findMany({
            orderBy: { createdAt: 'desc' }
        });
        res.json(quotations);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.exportQuotationsData = async (req, res) => {
    try {
        const quotations = await prisma.quotation.findMany({
            include: { items: true },
            orderBy: { createdAt: 'desc' }
        });

        // Calcular reservas globales
        const reservedItems = await prisma.quotationItem.findMany({
            where: { quotation: { status: 'RESERVADO' } }
        });
        const reservationMap = {};
        reservedItems.forEach(item => {
            reservationMap[item.productId] = (reservationMap[item.productId] || 0) + item.quantity;
        });

        // Calcular stock desde product.json y movimiento.json (igual que en getQuotationByNumber)
        const dbWarehouses = await prisma.warehouse.findMany();
        const ventasNames = dbWarehouses
            .filter(w => {
                const aliasLower = (w.alias || '').toLowerCase();
                const nameLower = (w.name || '').toLowerCase();
                return aliasLower === 'ventas' || nameLower.includes('principal') || nameLower.includes('ventas');
            })
            .map(w => w.name);
        if (ventasNames.length === 0) ventasNames.push("Almacén - Almacén principal");

        const allDbProducts = await prisma.product.findMany({ select: { internal_id: true, originWarehouse: true, stock: true, warehouse: true } });
        const originMap = {};
        allDbProducts.forEach(p => { if (p.originWarehouse) originMap[p.internal_id] = p.originWarehouse; });

        const aliasMap = {};
        dbWarehouses.forEach(w => { aliasMap[w.name] = w.alias || (w.name.includes(' - ') ? w.name.split(' - ')[1].trim() : w.name); });

        const jsonPath = path.join(__dirname, '../../data', 'product.json');
        const movPath = path.join(__dirname, '../../data', 'movimiento.json');
        const stockMap = {};
        const seen = new Set();

        const processItem = (internal_id, stock, whName) => {
            const key = `${internal_id}-${whName.toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);

            const originAlias = originMap[internal_id];
            if (originAlias) {
                const alias = aliasMap[whName] || (whName.includes(' - ') ? whName.split(' - ')[1].trim() : whName);
                if (alias.toLowerCase() === originAlias.toLowerCase()) {
                    stockMap[internal_id] = (stockMap[internal_id] || 0) + stock;
                }
            } else {
                const isVentas = ventasNames.some(vn => vn.toLowerCase() === whName.toLowerCase()) || whName.toLowerCase().includes('principal') || whName.toLowerCase().includes('ventas');
                if (!isVentas) {
                    stockMap[internal_id] = (stockMap[internal_id] || 0) + stock;
                }
            }
        };

        if (fs.existsSync(jsonPath)) {
            try {
                const dataArray = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                dataArray.forEach(p => processItem(p.internal_id, p.stock || 0, p.warehouse_name || ''));
                if (fs.existsSync(movPath)) {
                    const movData = JSON.parse(fs.readFileSync(movPath, 'utf8'));
                    const movArray = movData.data ? movData.data : movData;
                    movArray.forEach(m => {
                        if (m.item_internal_id) processItem(m.item_internal_id, m.stock || 0, m.warehouse_description || '');
                    });
                }
            } catch(e) { console.error(e); }
        } else {
            allDbProducts.forEach(p => processItem(p.internal_id, p.stock || 0, p.warehouse || ''));
        }

        // Obtener historial del kardex
        const kardexPath = path.join(__dirname, '../../data', 'kardex_ingresos.json');
        let kData = [];
        if (fs.existsSync(kardexPath)) {
            try { kData = JSON.parse(fs.readFileSync(kardexPath, 'utf8')); } catch(e){}
        }

        const exportData = [];
        quotations.forEach(q => {
            // Optimizar la busqueda en kardex para la cotizacion actual
            const qKardex = kData.filter(k => k.comments && k.comments.includes(`COT: ${q.number}`));
            const transferredItemCodes = new Set(qKardex.map(k => k.item_code));

            if (q.items && q.items.length > 0) {
                q.items.forEach(item => {
                    const isTransferred = transferredItemCodes.has(item.productId);
                    const stockTotal = stockMap[item.productId] || 0;
                    const reservaGlobal = reservationMap[item.productId] || 0;
                    const stockDispGlobal = stockTotal - reservaGlobal;

                    exportData.push({
                        Cotizacion: q.number,
                        Fecha: q.createdAt ? new Date(q.createdAt).toISOString().split('T')[0] : q.date,
                        Cliente: q.customerName || "-",
                        RUC: q.customerRuc || "-",
                        Vendedor: q.sellerName || "-",
                        Estado: q.status,
                        Observacion: q.observationText || "-",
                        Producto: item.description || item.productId,
                        Codigo: item.productId,
                        Requerido: item.quantity,
                        Stock_Total: stockTotal,
                        Reserva_Global: reservaGlobal,
                        Stock_Disp: stockDispGlobal,
                        Trasladado: isTransferred ? "SI" : "NO"
                    });
                });
            } else {
                exportData.push({
                    Cotizacion: q.number,
                    Fecha: q.createdAt ? new Date(q.createdAt).toISOString().split('T')[0] : q.date,
                    Cliente: q.customerName || "-",
                    RUC: q.customerRuc || "-",
                    Vendedor: q.sellerName || "-",
                    Estado: q.status,
                    Observacion: q.observationText || "-",
                    Producto: "SIN PRODUCTOS",
                    Codigo: "-",
                    Requerido: 0,
                    Stock_Total: 0,
                    Reserva_Global: 0,
                    Stock_Disp: 0,
                    Trasladado: "-"
                });
            }
        });

        res.json({ success: true, data: exportData });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Ruta para eliminar una cotizaci├│n
exports.deleteQuotation = async (req, res) => {
    let { number } = req.params;
    number = number.toUpperCase();
    const fullNumber = (number.startsWith('COT-') || number.startsWith('EXT-')) ? number : `COT-${number}`;

    try {
        const quotation = await prisma.quotation.findUnique({ where: { number: fullNumber } });
        if (!quotation) {
            return res.status(404).json({ success: false, error: "Cotizaci├│n no encontrada en el sistema local." });
        }

        // Primero borramos los items asociados (QuotationItem)
        await prisma.quotationItem.deleteMany({
            where: { quotationId: quotation.id }
        });

// Luego borramos la cotizaci├│n (Quotation)
        await prisma.quotation.delete({
            where: { id: quotation.id }
        });

        res.json({ success: true, message: `Cotizaci├│n ${fullNumber} eliminada correctamente.` });
    } catch (error) {
        console.error("Error al eliminar cotizaci├│n:", error);
        res.status(500).json({ success: false, error: "Error interno al eliminar la cotizaci├│n." });
    }
};

// Ruta para cambiar estado de cotizaci├│n
exports.updateQuotationStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['PENDIENTE', 'RESERVADO', 'TRASLADADO', 'TRASLADO PARCIAL', 'FACTURADO'].includes(status)) {
        return res.status(400).json({ success: false, error: "Estado no v├ílido" });
    }

    try {
        const updated = await prisma.quotation.update({
            where: { id },
            data: { status }
        });
        res.json({ success: true, quotation: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Ruta para actualizar la fecha de importación
exports.updateQuotationDate = async (req, res) => {
    const { id } = req.params;
    const { newDate } = req.body;

    if (!newDate) return res.status(400).json({ error: "Falta la nueva fecha." });

    try {
        const parsedDate = new Date(newDate);
        if (isNaN(parsedDate)) return res.status(400).json({ error: "Fecha inválida." });

        const updated = await prisma.quotation.update({
            where: { id },
            data: { createdAt: parsedDate }
        });
        res.json({ success: true, quotation: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Ruta para actualizar la observación manual
exports.updateQuotationObservation = async (req, res) => {
    const { id } = req.params;
    const { isObserved, observationText } = req.body;

    try {
        const updated = await prisma.quotation.update({
            where: { id },
            data: { 
                isObserved: isObserved,
                observationText: observationText
            }
        });
        res.json({ success: true, quotation: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Ruta para obtener almacenes

exports.transferAll = async (req, res) => {
    const { id } = req.params;
    const { target_warehouse_id, selected_item_ids } = req.body;

    if (!target_warehouse_id) {
        return res.status(400).json({ success: false, error: "Debe seleccionar un almacén destino." });
    }

    try {
        const quotation = await prisma.quotation.findUnique({
            where: { id },
            include: { items: true }
        });

        if (!quotation) return res.status(404).json({ success: false, error: "Cotización no encontrada" });
        if (quotation.status === 'TRASLADADO') return res.status(400).json({ success: false, error: "Esta cotización ya fue trasladada en su totalidad." });

        const creds = getSavedCredentials();
        if (!creds.almacenEmail || !creds.almacenPassword) {
            return res.status(400).json({ success: false, error: "Faltan configurar las credenciales de Almacén." });
        }

        const { client, login } = require('../services/volperService');
        await login(creds.almacenEmail, creds.almacenPassword);

        const invPage = await client.get('/inventory');
        const cheerio = require('cheerio');
        const $ = cheerio.load(invPage.data);
        const csrfToken = $('meta[name="csrf-token"]').attr('content') || $('input[name="_token"]').val();

        if (!csrfToken) throw new Error("No se pudo obtener el token CSRF de la sesión.");

        const movPath = path.join(__dirname, '../../data', 'movimiento.json');
        let movArray = [];
        if (fs.existsSync(movPath)) {
            const raw = fs.readFileSync(movPath, 'utf8');
            const parsed = JSON.parse(raw);
            movArray = parsed.data || parsed;
        }

        const dbWarehouses = await prisma.warehouse.findMany();
        const aliasMap = {};
        dbWarehouses.forEach(w => {
            aliasMap[w.name.toLowerCase()] = { id: w.id, name: w.name };
            if (w.alias) aliasMap[w.alias.toLowerCase()] = { id: w.id, name: w.name };
        });

        const targetW = await prisma.warehouse.findUnique({ where: { id: parseInt(target_warehouse_id) } });
        if (!targetW) throw new Error("Almacén destino no encontrado");

        let cacheUpdates = [];
        let kardexRecords = [];
        let successCount = 0;

        // Leer kardex para saber cuáles ya están trasladados
        const kardexPath = path.join(__dirname, '../../data', 'kardex_ingresos.json');
        let transferredItemCodes = new Set();
        if (fs.existsSync(kardexPath)) {
            try {
                const kData = JSON.parse(fs.readFileSync(kardexPath, 'utf8'));
                kData.forEach(k => {
                    if (k.comments && k.comments.includes(`COT: ${quotation.number}`)) {
                        transferredItemCodes.add(k.item_code);
                    }
                });
            } catch(e){}
        }

        let itemsToTransfer = quotation.items;
        if (selected_item_ids && Array.isArray(selected_item_ids) && selected_item_ids.length > 0) {
            itemsToTransfer = quotation.items.filter(i => selected_item_ids.includes(i.id));
        }

        // Siempre excluir los ítems que ya fueron trasladados previamente
        itemsToTransfer = itemsToTransfer.filter(i => !transferredItemCodes.has(i.productId));

        for (const item of itemsToTransfer) {
            const product = await prisma.product.findUnique({ where: { internal_id: item.productId } });
            if (!product) continue;

            const originAlias = product.originWarehouse ? product.originWarehouse.toLowerCase() : null;
            let originWhId = null;
            let originWhDesc = "";

            if (originAlias && aliasMap[originAlias]) {
                originWhId = aliasMap[originAlias].id;
                originWhDesc = aliasMap[originAlias].name;
            } else {
                const itemMovs = movArray.filter(m => m.item_internal_id === item.productId && m.warehouse_id !== parseInt(target_warehouse_id));
                if (itemMovs.length > 0) {
                    itemMovs.sort((a,b) => b.stock - a.stock);
                    originWhId = itemMovs[0].warehouse_id;
                    originWhDesc = itemMovs[0].warehouse_description;
                }
            }

            if (!originWhId) continue;
            if (originWhId === parseInt(target_warehouse_id)) continue;

            let movData = movArray.find(m => m.item_internal_id === item.productId && m.warehouse_id === originWhId);
            
            // Si no hay movData para ese almacén, buscar el item_id en cualquier otro registro
            let volperItemId = movData ? movData.item_id : null;
            if (!volperItemId) {
                const anyMov = movArray.find(m => m.item_internal_id === item.productId);
                if (anyMov) volperItemId = anyMov.item_id;
            }

            if (!volperItemId) continue; // Si no hay forma de saber el ID de Volper, saltamos

            const currentStock = movData ? (parseFloat(movData.stock) || 0) : 0;

            const payload = {
                id: null,
                item_id: parseInt(volperItemId),
                item_description: item.description || "",
                warehouse_id: parseInt(originWhId),
                warehouse_description: originWhDesc,
                quantity: currentStock,
                warehouse_new_id: parseInt(target_warehouse_id),
                quantity_move: String(item.quantity),
                quantity_real: currentStock,
                lots_enabled: false,
                series_enabled: false,
                lots: [],
                lots_group: []
            };

            const response = await client.post('/inventory/move', payload, {
                headers: {
                    'X-CSRF-TOKEN': csrfToken,
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });

            if (response.data && response.data.success !== false) {
                successCount++;
                cacheUpdates.push({
                    productId: item.productId,
                    fromId: originWhId,
                    toId: parseInt(target_warehouse_id),
                    quantity: parseFloat(item.quantity)
                });
                kardexRecords.push({
                    id: Date.now() + successCount,
                    date: new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }),
                    item_id: volperItemId,
                    item_code: item.productId,
                    item_description: item.description,
                    warehouse_id: originWhId,
                    warehouse_description: originWhDesc,
                    initial_stock: currentStock,
                    added_quantity: -parseFloat(item.quantity),
                    final_stock: currentStock - parseFloat(item.quantity),
                    comments: `Traslado Masivo COT: ${quotation.number} hacia: ${targetW.name}`
                });
            }
        }

        if (successCount > 0) {
            let kData = [];
            if (fs.existsSync(kardexPath)) {
                try { kData = JSON.parse(fs.readFileSync(kardexPath, 'utf8')); } catch(e){}
            }
            kData.push(...kardexRecords);
            fs.writeFileSync(kardexPath, JSON.stringify(kData, null, 2));

            let currentTransferredItemCodes = new Set();
            kData.forEach(k => {
                if (k.comments && k.comments.includes(`COT: ${quotation.number}`)) {
                    currentTransferredItemCodes.add(k.item_code);
                }
            });

            // Verificar si TODOS los ítems de la cotización ya fueron trasladados
            let allTransferred = true;
            for (let i of quotation.items) {
                if (!currentTransferredItemCodes.has(i.productId)) {
                    allTransferred = false;
                    break;
                }
            }

            const newStatus = allTransferred ? 'TRASLADADO' : 'TRASLADO PARCIAL';

            await prisma.quotation.update({
                where: { id },
                data: { status: newStatus }
            });

            for (const upd of cacheUpdates) {
                // Verificar si existe el movData en el origen/destino, sino crearlo
                let foundFrom = false;
                let foundTo = false;
                for (let m of movArray) {
                    if (m.item_internal_id === upd.productId && m.warehouse_id === upd.fromId) {
                        m.stock = (parseFloat(m.stock) || 0) - upd.quantity;
                        foundFrom = true;
                    }
                    if (m.item_internal_id === upd.productId && m.warehouse_id === upd.toId) {
                        m.stock = (parseFloat(m.stock) || 0) + upd.quantity;
                        foundTo = true;
                    }
                }
                
                // Si no existía el registro en movimiento.json para el almacén destino, deberíamos agregarlo,
                // pero como la API de Volper lo crea, la próxima actualización automática lo traerá.
                // Lo mismo para el origen.
            }
            fs.writeFileSync(movPath, JSON.stringify({ data: movArray }, null, 2));

            const prodPath = path.join(__dirname, '../../data', 'product.json');
            if (fs.existsSync(prodPath)) {
                const pData = JSON.parse(fs.readFileSync(prodPath, 'utf8'));
                
                const getWhId = (wName) => {
                    const lower = wName.toLowerCase();
                    if (aliasMap[lower]) return aliasMap[lower].id;
                    for (const w of dbWarehouses) {
                        if (lower.includes((w.alias || '').toLowerCase()) && w.alias) return w.id;
                        if (lower.includes(w.name.toLowerCase())) return w.id;
                        const cleanName = lower.replace('almacén - ', '').trim();
                        if (w.name.toLowerCase().includes(cleanName)) return w.id;
                    }
                    return null;
                };

                for (const upd of cacheUpdates) {
                    for (let p of pData) {
                        const pWhId = getWhId(p.warehouse_name || '');
                        if (p.internal_id === upd.productId && pWhId === upd.fromId) {
                            p.stock = (parseFloat(p.stock) || 0) - upd.quantity;
                        }
                        if (p.internal_id === upd.productId && pWhId === upd.toId) {
                            p.stock = (parseFloat(p.stock) || 0) + upd.quantity;
                        }
                    }
                }
                fs.writeFileSync(prodPath, JSON.stringify(pData, null, 2));
            }
        }

        res.json({ success: true, message: `Traslado masivo completado. ${successCount} items trasladados con éxito.` });

    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
};

exports.getQuotationByNumber = async (req, res) => {
    try {
        const { number } = req.params;

        // Buscamos la cotizaci├│n y usamos el internal_id para traer el stock de la tabla Product
        const quotation = await prisma.quotation.findUnique({
            where: { number: number },
            include: { items: true }
        });

        if (!quotation) return res.status(404).json({ error: "Cotizaci├│n no encontrada" });

        // Calcular reservas globales
        const reservedItems = await prisma.quotationItem.findMany({
            where: { quotation: { status: 'RESERVADO' } }
        });
        const reservationMap = {};
        reservedItems.forEach(item => {
            reservationMap[item.productId] = (reservationMap[item.productId] || 0) + item.quantity;
        });

        // Obtener todos los almacenes de la BD para identificar cu├íles son "Ventas" (y excluirlos)
        const dbWarehouses = await prisma.warehouse.findMany();
        const ventasNames = dbWarehouses
            .filter(w => {
                const aliasLower = (w.alias || '').toLowerCase();
                const nameLower = (w.name || '').toLowerCase();
                return aliasLower === 'ventas' || nameLower.includes('principal') || nameLower.includes('ventas');
            })
            .map(w => w.name);

        // Por si acaso, si no hay almacenes registrados en la BD local, usamos el por defecto de Ventas
        if (ventasNames.length === 0) {
            ventasNames.push("Almac├®n - Almac├®n principal");
        }

        // Obtener or├¡genes configurados en la BD
        const allDbProducts = await prisma.product.findMany({ select: { internal_id: true, originWarehouse: true } });
        const originMap = {};
        allDbProducts.forEach(p => {
            if (p.originWarehouse) originMap[p.internal_id] = p.originWarehouse;
        });

        const aliasMap = {};
        dbWarehouses.forEach(w => {
            aliasMap[w.name] = w.alias || (w.name.includes(' - ') ? w.name.split(' - ')[1].trim() : w.name);
        });

        const jsonPath = path.join(__dirname, '../../data', 'product.json');
        const movPath = path.join(__dirname, '../../data', 'movimiento.json');
        const stockMap = {};
        const seen = new Set();

        // Función auxiliar para procesar items
        const processItem = (internal_id, stock, whName) => {
            const key = `${internal_id}-${whName.toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);

            const originAlias = originMap[internal_id];
            
            if (originAlias) {
                // Si tiene origen definido, SOLO sumar de ese almac├®n
                const alias = aliasMap[whName] || (whName.includes(' - ') ? whName.split(' - ')[1].trim() : whName);
                if (alias.toLowerCase() === originAlias.toLowerCase()) {
                    stockMap[internal_id] = (stockMap[internal_id] || 0) + stock;
                }
            } else {
                // Si NO tiene origen definido, sumar de cualquier almac├®n que NO sea ventas/principal
                const isVentas = ventasNames.some(vn => vn.toLowerCase() === whName.toLowerCase()) ||
                    whName.toLowerCase().includes('principal') ||
                    whName.toLowerCase().includes('ventas');
                
                if (!isVentas) {
                    stockMap[internal_id] = (stockMap[internal_id] || 0) + stock;
                }
            }
        };

        if (fs.existsSync(jsonPath)) {
            try {
                // Procesar product.json
                const dataArray = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                dataArray.forEach(p => processItem(p.internal_id, p.stock || 0, p.warehouse_name || ''));
                
                // Procesar movimiento.json para los productos faltantes (igual que en /api/products)
                if (fs.existsSync(movPath)) {
                    const movData = JSON.parse(fs.readFileSync(movPath, 'utf8'));
                    const movArray = movData.data ? movData.data : movData;
                    movArray.forEach(m => {
                        if (m.item_internal_id) {
                            processItem(m.item_internal_id, m.stock || 0, m.warehouse_description || '');
                        }
                    });
                }
            } catch(e) { console.error("Error leyendo JSONs para stock:", e); }
        } else {
            allDbProducts.forEach(p => {
                processItem(p.internal_id, p.stock || 0, p.warehouse || '');
            });
        }

        // Check kardex for transferred items
        const kardexPath = path.join(__dirname, '../../data', 'kardex_ingresos.json');
        let transferredItemCodes = new Set();
        if (fs.existsSync(kardexPath)) {
            try {
                const kData = JSON.parse(fs.readFileSync(kardexPath, 'utf8'));
                // Comentarios como: "Traslado Masivo COT: COT-1670 hacia: ..."
                kData.forEach(k => {
                    if (k.comments && k.comments.includes(`COT: ${quotation.number}`)) {
                        transferredItemCodes.add(k.item_code);
                    }
                });
            } catch(e) {}
        }

        // Mapeamos los items para calcular su estado real
        const itemsSincerados = quotation.items.map(item => {
            const stockTotal = stockMap[item.productId] || 0;
            const reservaGlobal = reservationMap[item.productId] || 0;
            const stockDispGlobal = stockTotal - reservaGlobal;

            // Si esta cotización YA ESTÁ reservada, su cantidad es parte de "reservaGlobal",
            // así que para evaluar si se puede cumplir, "le devolvemos" su propia cantidad al disponible
            const miReserva = (quotation.status === 'RESERVADO') ? item.quantity : 0;
            const stockDisponibleParaMi = stockDispGlobal + miReserva;

            const isTransferred = transferredItemCodes.has(item.productId);

            return {
                ...item,
                isTransferred,
                stockTotal,
                reservaGlobal,
                stockDispGlobal,
                stockDisponibleParaMi
            };
        });

        res.json({ ...quotation, items: itemsSincerados });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.reviewTempQuotation = async (req, res) => {
    let number = req.params.number.trim();
    if (!number.startsWith('COT-')) {
        number = 'COT-' + number;
    }

    try {
        const creds = getSavedCredentials();
        const email = creds.ventasEmail;
        const password = creds.ventasPassword;

        if (!email || !password) {
            return res.status(400).json({ error: "Faltan configurar las credenciales de Ventas/Administrador." });
        }

        const axios = require('axios');
        const { wrapper } = require('axios-cookiejar-support');
        const { CookieJar } = require('tough-cookie');
        const cheerio = require('cheerio');

        const jar = new CookieJar();
        const client = wrapper(axios.create({
            jar,
            withCredentials: true,
            baseURL: 'https://volperseal.goldensystem.com.pe'
        }));

        async function login(email, password) {
            const loginPage = await client.get('/login');
            const $ = cheerio.load(loginPage.data);
            const csrfToken = $('input[name="_token"]').val();
            if (!csrfToken) throw new Error("No se pudo extraer el Token CSRF.");

            const loginResponse = await client.post('/login', new URLSearchParams({
                '_token': csrfToken,
                'email': email,
                'password': password
            }));

            const finalUrl = loginResponse.request.res ? loginResponse.request.res.responseUrl : loginResponse.request.path;
            if (finalUrl && finalUrl.endsWith('/login')) {
                 throw new Error("Credenciales inválidas");
            }
        }

        await login(email, password);

        const quotId = number.replace(/\D/g, '');
        if (!quotId) {
            return res.status(400).json({ error: "El formato de número de cotización no es válido." });
        }

        const detailResponse = await client.get(`/quotations/record/${quotId}`);
        
        if (typeof detailResponse.data === 'string' && detailResponse.data.includes('<html')) {
            throw new Error("Sesión expirada o denegada en Volper Seal.");
        }

        const detail = detailResponse.data.data;
        if (!detail || !detail.quotation) {
            return res.status(404).json({ error: `No se encontró la cotización ${number} en el servidor.` });
        }

        // Simular formato de Prisma para el Frontend
        const tempQuotation = {
            number: detail.number_full,
            date: detail.date_of_issue,
            customerName: detail.quotation.customer.name || "Sin nombre",
            customerRuc: detail.quotation.customer.number || "Sin RUC",
            sellerName: "Revisión Temporal",
            status: "REVISIÓN",
            items: []
        };

        if (detail.quotation.items) {
            detail.quotation.items.forEach(line => {
                tempQuotation.items.push({
                    productId: line.item.internal_id || "SIN-CODIGO",
                    description: line.item.description || "Sin descripción",
                    quantity: parseFloat(line.quantity) || 0
                });
            });
        }

        // Calcular stock (Mismo bloque de getQuotationByNumber)
        const reservedItems = await prisma.quotationItem.findMany({
            where: { quotation: { status: 'RESERVADO' } }
        });
        const reservationMap = {};
        reservedItems.forEach(item => {
            reservationMap[item.productId] = (reservationMap[item.productId] || 0) + item.quantity;
        });

        const dbWarehouses = await prisma.warehouse.findMany();
        const ventasNames = dbWarehouses
            .filter(w => {
                const aliasLower = (w.alias || '').toLowerCase();
                const nameLower = (w.name || '').toLowerCase();
                return aliasLower === 'ventas' || nameLower.includes('principal') || nameLower.includes('ventas');
            })
            .map(w => w.name);

        if (ventasNames.length === 0) ventasNames.push("Almacén - Almacén principal");

        const allDbProducts = await prisma.product.findMany({ select: { internal_id: true, originWarehouse: true } });
        const originMap = {};
        allDbProducts.forEach(p => { if (p.originWarehouse) originMap[p.internal_id] = p.originWarehouse; });

        const aliasMap = {};
        dbWarehouses.forEach(w => { aliasMap[w.name] = w.alias || (w.name.includes(' - ') ? w.name.split(' - ')[1].trim() : w.name); });

        const jsonPath = path.join(__dirname, '../../data', 'product.json');
        const movPath = path.join(__dirname, '../../data', 'movimiento.json');
        const stockMap = {};
        const seen = new Set();

        const processItem = (internal_id, stock, whName) => {
            const key = `${internal_id}-${whName.toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);

            const originAlias = originMap[internal_id];
            if (originAlias) {
                const alias = aliasMap[whName] || (whName.includes(' - ') ? whName.split(' - ')[1].trim() : whName);
                if (alias.toLowerCase() === originAlias.toLowerCase()) {
                    stockMap[internal_id] = (stockMap[internal_id] || 0) + stock;
                }
            } else {
                const isVentas = ventasNames.some(vn => vn.toLowerCase() === whName.toLowerCase()) ||
                    whName.toLowerCase().includes('principal') || whName.toLowerCase().includes('ventas');
                if (!isVentas) stockMap[internal_id] = (stockMap[internal_id] || 0) + stock;
            }
        };

        if (fs.existsSync(jsonPath)) {
            try {
                const dataArray = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                dataArray.forEach(p => processItem(p.internal_id, p.stock || 0, p.warehouse_name || ''));
                if (fs.existsSync(movPath)) {
                    const movData = JSON.parse(fs.readFileSync(movPath, 'utf8'));
                    const movArray = movData.data ? movData.data : movData;
                    movArray.forEach(m => { if (m.item_internal_id) processItem(m.item_internal_id, m.stock || 0, m.warehouse_description || ''); });
                }
            } catch(e) {}
        }

        const itemsSincerados = tempQuotation.items.map(item => {
            const stockTotal = stockMap[item.productId] || 0;
            const reservaGlobal = reservationMap[item.productId] || 0;
            const stockDispGlobal = stockTotal - reservaGlobal;
            return {
                ...item,
                isTransferred: false,
                stockTotal,
                reservaGlobal,
                stockDispGlobal,
                stockDisponibleParaMi: stockDispGlobal
            };
        });

        res.json({ ...tempQuotation, items: itemsSincerados });
    } catch (error) {
        console.error("Error en reviewTempQuotation:", error.message);
        res.status(500).json({ error: error.message });
    }
};
