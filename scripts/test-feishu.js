const https = require('https');

const webhook = process.env.FEISHU_WEBHOOK;

if (!webhook) {
    console.error('❌ 错误: 环境变量 FEISHU_WEBHOOK 未设置');
    process.exit(1);
}

console.log(`📡 正在尝试向 Webhook 推送测试消息 (URL 前缀: ${webhook.substring(0, 50)}...)`);

const data = JSON.stringify({
    msg_type: 'text',
    content: {
        text: '🔔 这是一条来自每日汽车要闻脚本的【测试消息】，如果您收到了，说明 Webhook 配置正确。'
    }
});

const req = https.request(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
}, (res) => {
    let rawData = '';
    res.on('data', (chunk) => rawData += chunk);
    res.on('end', () => {
        console.log(`✅ 推送完成，HTTP 状态码: ${res.statusCode}`);
        console.log(`📄 响应内容: ${rawData}`);
    });
});

req.on('error', (e) => {
    console.error(`❌ 请求失败: ${e.message}`);
});

req.write(data);
req.end();
