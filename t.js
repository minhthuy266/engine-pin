const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

async function listModels() {
    try {
        console.log("--- CHECKING ANTHROPIC MODELS FOR LINA ---");
        const response = await anthropic.models.list({ limit: 20 });
        
        console.log("✅ Các phiên bản bạn có thể dùng ngay bây giờ:");
        response.data.forEach(model => {
            console.log(`- ${model.id}`);
        });
        
    } catch (err) {
        console.error("❌ Lỗi kiểm tra:", err.message);
        if (err.status === 401) console.log("👉 Kiểm tra lại API Key trong file .env nhé, hình như nó bị sai hoặc thừa dấu cách.");
        if (err.status === 404) console.log("👉 Tài khoản của bạn thực sự chưa được cấp quyền cho các model này.");
    }
}

listModels();