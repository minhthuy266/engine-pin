const { GoogleAuth } = require('google-auth-library');
require('dotenv').config();

async function testUrl(url) {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    console.log(`Testing ${url.substring(0, 100)}...`);
    try {
        const res = await client.request({ url, method: 'POST', data: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } });
        console.log(`✅ Success!`);
        return true;
    } catch (e) {
        console.log(`❌ Failed: ${e.response?.status || e.message}`);
        if (e.response?.data) console.log(JSON.stringify(e.response.data).substring(0, 200));
        return false;
    }
}

async function main() {
    const project = 'solar-climber-492410-g1';
    const region = 'us-central1';
    const models = ['gemini-1.5-pro', 'gemini-3.1-pro-preview', 'gemini-3.1-pro'];
    
    for (const m of models) {
        // Pattern 1: Publisher
        await testUrl(`https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${m}:generateContent`);
        // Pattern 2: Beta Publisher
        await testUrl(`https://${region}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${region}/publishers/google/models/${m}:generateContent`);
        // Pattern 3: No Publisher
        await testUrl(`https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/models/${m}:generateContent`);
    }
}
main();
