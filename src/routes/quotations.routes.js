const express = require('express');
const router = express.Router();
const quotationsController = require('../controllers/quotations.controller');

router.post('/add-quotation', quotationsController.addQuotation);
router.get('/customer-quotations', quotationsController.getCustomerQuotations);
router.get('/import-customer-progress', quotationsController.getImportCustomerProgress);
router.post('/import-customer-quotations', quotationsController.importCustomerQuotations);
router.delete('/customer-quotations', quotationsController.deleteCustomerQuotations);
router.get('/review-quotation/:number', quotationsController.reviewQuotation);
router.get('/quotations', quotationsController.getQuotations);
router.delete('/quotations/:number', quotationsController.deleteQuotation);
router.put('/quotations/:id/status', quotationsController.updateQuotationStatus);
router.put('/quotations/:id/date', quotationsController.updateQuotationDate);
router.get('/quotations/:number', quotationsController.getQuotationByNumber);
router.post('/quotations/:id/transfer-all', quotationsController.transferAll);
router.post('/quotations/manual', quotationsController.createManualQuotation);

module.exports = router;
