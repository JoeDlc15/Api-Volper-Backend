require('dotenv').config();
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

async function testFilter() {
    try {
        console.log("Iniciando login...");
        const loginPage = await client.get('/login');
        const $ = cheerio.load(loginPage.data);
        const csrfToken = $('input[name="_token"]').val();

        await client.post('/login', new URLSearchParams({
            '_token': csrfToken,
            'email': process.env.API_EMAIL,
            'password': process.env.API_PASSWORD
        }));
        
        console.log("Login exitoso, testeando filtros...");

        const filters = ['01', '02', '03', '04', '', 'all'];
        
        for (const f of filters) {
            const url = `/inventory/report/records?active&brand_id&category_id&filter=${f}&page=1&warehouse_id=3`;
            const res = await client.get(url);
            console.log(`Filtro "${f}": Meta Last Page: ${res.data?.meta?.last_page}, Data Length: ${res.data?.data?.length}`);
        }
    } catch (e) {
        console.error("Error:", e.message);
    }
}

testFilter();
