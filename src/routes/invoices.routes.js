const express = require('express');
const router = express.Router();
const invoicesController = require('../controllers/invoices.controller');

router.post('/sync-invoices', invoicesController.syncInvoices);

module.exports = router;
