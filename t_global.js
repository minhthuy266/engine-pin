const { GoogleAuth } = require('google-auth-library');
require('dotenv').config();

async function testGlobal() {
    const project = 'solar-climber-492410-g1';
    const region = 'global';
    const modelId = 'gemini-1.5-pro';
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    
    const url = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${modelId}:generateContent`;

    console.log(`Testing truncation for ${modelId} in GLOBAL region...`);
    try {
        const res = await client.request({
            url,
            method: 'POST',
            data: { 
                contents: [{ role: 'user', parts: [{ text: 'Generate a 2000 word essay about beauty' }] }] 
            }
        });
        const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        console.log(`Length: ${text.length}`);
    } catch (e) {
        console.log(`❌ Failed: ${e.response?.status || e.message}`);
        if (e.response?.data) console.log(JSON.stringify(e.response.data, null, 2));
    }
}

testGlobal();
