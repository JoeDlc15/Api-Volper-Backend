const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'quotations.controller.js');
let code = fs.readFileSync(file, 'utf8');

const newCode = `

exports.transferAll = async (req, res) => {
    const { id } = req.params;
    const { target_warehouse_id } = req.body;

    if (!target_warehouse_id) {
        return res.status(400).json({ success: false, error: "Debe seleccionar un almacén destino." });
    }

    try {
        const quotation = await prisma.quotation.findUnique({
            where: { id },
            include: { items: true }
        });

        if (!quotation) return res.status(404).json({ success: false, error: "Cotización no encontrada" });
        if (quotation.status === 'TRASLADADO') return res.status(400).json({ success: false, error: "Esta cotización ya fue trasladada." });

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

        for (const item of quotation.items) {
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
            // Skip if origin and target are the same
            if (originWhId === parseInt(target_warehouse_id)) continue;

            const movData = movArray.find(m => m.item_internal_id === item.productId && m.warehouse_id === originWhId);
            if (!movData) continue;

            const volperItemId = movData.item_id;

            const payload = {
                id: null,
                item_id: parseInt(volperItemId),
                item_description: item.description || "",
                warehouse_id: parseInt(originWhId),
                warehouse_description: originWhDesc,
                quantity: parseFloat(movData.stock) || 0,
                warehouse_new_id: parseInt(target_warehouse_id),
                quantity_move: String(item.quantity),
                quantity_real: parseFloat(movData.stock) || 0,
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
                    initial_stock: parseFloat(movData.stock) || 0,
                    added_quantity: -parseFloat(item.quantity),
                    final_stock: (parseFloat(movData.stock) || 0) - parseFloat(item.quantity),
                    comments: \`Traslado Masivo COT: \${quotation.number} hacia: \${targetW.name}\`
                });
            }
        }

        if (successCount > 0) {
            await prisma.quotation.update({
                where: { id },
                data: { status: 'TRASLADADO' }
            });

            const kardexPath = path.join(__dirname, '../../data', 'kardex_ingresos.json');
            let kData = [];
            if (fs.existsSync(kardexPath)) {
                try { kData = JSON.parse(fs.readFileSync(kardexPath, 'utf8')); } catch(e){}
            }
            kData.push(...kardexRecords);
            fs.writeFileSync(kardexPath, JSON.stringify(kData, null, 2));

            for (const upd of cacheUpdates) {
                for (let m of movArray) {
                    if (m.item_internal_id === upd.productId && m.warehouse_id === upd.fromId) {
                        m.stock = (parseFloat(m.stock) || 0) - upd.quantity;
                    }
                    if (m.item_internal_id === upd.productId && m.warehouse_id === upd.toId) {
                        m.stock = (parseFloat(m.stock) || 0) + upd.quantity;
                    }
                }
            }
            fs.writeFileSync(movPath, JSON.stringify({ data: movArray }, null, 2));

            const prodPath = path.join(__dirname, '../../data', 'product.json');
            if (fs.existsSync(prodPath)) {
                const pData = JSON.parse(fs.readFileSync(prodPath, 'utf8'));
                for (const upd of cacheUpdates) {
                    const fromAlias = dbWarehouses.find(w => w.id === upd.fromId)?.alias?.toLowerCase() || '';
                    const toAlias = dbWarehouses.find(w => w.id === upd.toId)?.alias?.toLowerCase() || '';
                    for (let p of pData) {
                        const pName = (p.warehouse_name || '').toLowerCase();
                        if (p.internal_id === upd.productId && (pName.includes(fromAlias) || pName === fromAlias)) {
                            p.stock = (parseFloat(p.stock) || 0) - upd.quantity;
                        }
                        if (p.internal_id === upd.productId && (pName.includes(toAlias) || pName === toAlias)) {
                            p.stock = (parseFloat(p.stock) || 0) + upd.quantity;
                        }
                    }
                }
                fs.writeFileSync(prodPath, JSON.stringify(pData, null, 2));
            }
        }

        res.json({ success: true, message: \`Traslado masivo completado. \${successCount} items trasladados con éxito.\` });

    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
};
`;

fs.writeFileSync(file, code + newCode);
console.log("Appended");
