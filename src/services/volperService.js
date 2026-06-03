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

module.exports = {
    client,
    login
};
