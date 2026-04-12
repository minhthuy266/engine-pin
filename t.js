const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
require('dotenv').config();

async function test(modelId) {
    const project = 'solar-climber-492410-g1';
    const region = 'us-central1';
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const url = `https://${region}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${region}/publishers/google/models/${modelId}:generateContent`;

    console.log(`Testing ${modelId}...`);
    try {
        const res = await client.request({
            url,
            method: 'POST',
            data: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
        });
        console.log(`✅ ${modelId} works!`);
    } catch (e) {
        console.log(`❌ ${modelId} failed: ${e.response?.status || e.message}`);
    }
}

async function main() {
    await test('gemini-3.1-pro-preview');
    await test('gemini-1.5-pro-001');
    await test('gemini-1.5-flash-002');
    await test('gemini-1.5-flash-001');
    await test('gemini-1.5-pro');
    await test('gemini-1.5-flash');
}
main();