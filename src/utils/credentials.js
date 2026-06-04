const fs = require('fs');
const path = require('path');

function getSavedCredentials() {
    const credPath = path.join(__dirname, '../../data', 'credentials.json');
    if (fs.existsSync(credPath)) {
        try {
            return JSON.parse(fs.readFileSync(credPath, 'utf8'));
        } catch (e) {
            console.error("Error reading credentials.json:", e);
        }
    }
    return {
        ventasEmail: "",
        ventasPassword: "",
        almacenEmail: "",
        almacenPassword: ""
    };
}

function saveSavedCredentials(creds) {
    const credPath = path.join(__dirname, '../../data', 'credentials.json');
    fs.writeFileSync(credPath, JSON.stringify(creds, null, 4));
}

module.exports = {
    getSavedCredentials,
    saveSavedCredentials
};
