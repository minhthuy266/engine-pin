const { GoogleAuth } = require('google-auth-library');
require('dotenv').config();

async function testRegion(region) {
    const project = 'solar-climber-492410-g1';
    const modelId = 'gemini-1.5-pro';
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${modelId}:generateContent`;

    console.log(`Testing region ${region}...`);
    try {
        const res = await client.request({
            url,
            method: 'POST',
            data: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
        });
        console.log(`✅ ${region} works!`);
        return true;
    } catch (e) {
        console.log(`❌ ${region} failed: ${e.response?.status || e.message}`);
        return false;
    }
}

async function main() {
    const regions = ['us-central1', 'us-east1', 'us-west1', 'europe-west1', 'asia-southeast1', 'asia-northeast1'];
    for (const r of regions) {
        if (await testRegion(r)) break;
    }
}
main();
