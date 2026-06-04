const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventory.controller');

router.get('/update-catalog', inventoryController.updateCatalog);
router.get('/update-movimientos', inventoryController.updateMovimientos);
router.get('/movimientos', inventoryController.getMovimientos);
router.get('/last-updates', inventoryController.getLastUpdates);
router.get('/products', inventoryController.getProducts);
router.get('/catalog', inventoryController.getCatalog);
router.put('/catalog/:internal_id/origin', inventoryController.updateOrigin);
router.post('/catalog/import-origins', inventoryController.importOrigins);
router.get('/warehouses', inventoryController.getWarehouses);
router.put('/warehouses/:id', inventoryController.updateWarehouse);
router.post('/add-transaction', inventoryController.addTransaction);
router.post('/move-transaction', inventoryController.moveTransaction);
router.get('/kardex', inventoryController.getKardex);

module.exports = router;
