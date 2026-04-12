const { VertexAI } = require('@google-cloud/vertexai');
require('dotenv').config();

async function list() {
    const project = 'solar-climber-492410-g1';
    const location = 'us-central1';
    const vertexAI = new VertexAI({ project, location });

    console.log("Listing models via SDK...");
    // The SDK doesn't have a direct 'listModels' for publishers, 
    // but we can try to instantiate and see if it fails.
    try {
        const model = vertexAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
        const result = await model.generateContent('hi');
        console.log("✅ SDK can reach gemini-1.5-pro");
    } catch (e) {
        console.log("❌ SDK failed:", e.message);
    }
}
list();
