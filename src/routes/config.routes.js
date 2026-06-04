const express = require('express');
const router = express.Router();
const configController = require('../controllers/config.controller');

// Obtener credenciales
router.get('/credentials', configController.getCredentials);

// Guardar credenciales
router.post('/credentials', configController.saveCredentials);

module.exports = router;
