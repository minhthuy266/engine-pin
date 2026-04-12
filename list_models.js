const { GoogleAuth } = require('google-auth-library');
require('dotenv').config();

async function listModels() {
    const project = 'solar-climber-492410-g1';
    const region = 'us-central1';
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    
    // Listing publisher models from Google
    const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/models`;

    console.log(`Listing models in ${region}...`);
    try {
        const res = await client.request({ url, method: 'GET' });
        console.log('Available Models:');
        res.data.publisherModels.forEach(m => {
            console.log(`- ${m.name.split('/').pop()}`);
        });
    } catch (e) {
        console.log('Error listing models:', JSON.stringify(e.response?.data || e.message, null, 2));
    }
}

listModels();
