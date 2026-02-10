const https = require('https');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const CONFIG = {
  FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK || 'https://open.feishu.cn/open-apis/bot/v2/hook/37635cf6-2018-4e60-8afa-19f713141664',
  HISTORY_FILE: path.join(__dirname, '../memory/car-news-pushed.json'),
  BATCH_SIZE: 3,
};

// 获取今天的日期字符串 (格式: 20260211)
function getTodayStr() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

// 获取日期显示 (格式: 2月11日)
function getDisplayDate() {
  const now = new Date();
  return `${now.getMonth() + 1}月${now.getDate()}日`;
}

// HTTP GET 请求
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// 发送飞书卡片消息
async function sendFeishuCard(batchNum, totalBatches, newsItems) {
  const elements = [];
  
  newsItems.forEach((news, index) => {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${index + 1 + (batchNum - 1) * CONFIG.BATCH_SIZE}️⃣ ${news.title}**\n[🔗 查看原文](${news.url})\n💡 ${news.summary}`
      }
    });
    if (index < newsItems.length - 1) {
      elements.push({ tag: 'hr' });
    }
  });
  
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '📌 来源：汽车之家' }]
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📰 今日汽车早报（${getDisplayDate()}）- 第${batchNum}/${totalBatches}批` },
      template: 'blue'
    },
    elements
  };

  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ msg_type: 'interactive', card });
    
    const req = https.request(CONFIG.FEISHU_WEBHOOK, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(responseData);
          if (result.code === 0 || result.StatusCode === 0) {
            console.log(`✅ 第${batchNum}批发送成功`);
            resolve(result);
          } else {
            reject(new Error(`飞书API错误: ${result.msg || result.StatusMessage}`));
          }
        } catch (e) {
          resolve(responseData);
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 抓取新闻列表页
async function fetchNewsList() {
  console.log('📰 抓取新闻列表...');
  const html = await httpGet('https://www.autohome.com.cn/all/');
  const $ = cheerio.load(html);
  
  const newsList = [];
  const todayStr = getTodayStr().slice(4); // 获取 0211 格式
  
  // 查找所有新闻链接
  $('a[href*="/news/202602/"]').each((_, el) => {
    const href = $(el).attr('href');
    const title = $(el).text().trim();
    
    if (href && title && href.includes(`/news/202602/${todayStr}`)) {
      const fullUrl = href.startsWith('http') ? href : `https:${href}`;
      if (!newsList.find(n => n.url === fullUrl)) {
        newsList.push({ url: fullUrl, title });
      }
    }
  });
  
  console.log(`📊 找到 ${newsList.length} 条今日新闻`);
  return newsList.slice(0, 15); // 最多15条
}

// 抓取单条新闻详情
async function fetchNewsDetail(url) {
  try {
    const html = await httpGet(url);
    const $ = cheerio.load(html);
    
    // 提取正文内容（取前100字）
    const content = $('.article-content p, .post-content p').first().text().trim();
    const summary = content.slice(0, 50) + (content.length > 50 ? '...' : '');
    
    return summary || '点击查看详情';
  } catch (e) {
    return '点击查看详情';
  }
}

// 主函数
async function main() {
  console.log('🚀 每日汽车新闻推送开始');
  console.log(`📅 日期: ${getDisplayDate()}`);
  
  try {
    // 读取历史记录
    let history = { pushedUrls: [], lastUpdated: '' };
    if (fs.existsSync(CONFIG.HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(CONFIG.HISTORY_FILE, 'utf8'));
    }
    
    // 抓取新闻
    const newsList = await fetchNewsList();
    
    if (newsList.length === 0) {
      console.log('⚠️  今日暂无新闻');
      return;
    }
    
    // 去重
    const newNews = newsList.filter(n => !history.pushedUrls.includes(n.url));
    console.log(`📊 新新闻: ${newNews.length} 条`);
    
    if (newNews.length === 0) {
      console.log('✅ 所有新闻已推送过');
      return;
    }
    
    // 分批处理
    const batches = [];
    for (let i = 0; i < newNews.length; i += CONFIG.BATCH_SIZE) {
      batches.push(newNews.slice(i, i + CONFIG.BATCH_SIZE));
    }
    
    // 为每条新闻获取摘要
    for (const news of newNews) {
      news.summary = await fetchNewsDetail(news.url);
      await new Promise(r => setTimeout(r, 500)); // 延迟避免请求过快
    }
    
    // 发送分批消息
    for (let i = 0; i < batches.length; i++) {
      await sendFeishuCard(i + 1, batches.length, batches[i]);
      await new Promise(r => setTimeout(r, 1000)); // 批间延迟
    }
    
    // 更新历史记录
    history.pushedUrls.push(...newNews.map(n => n.url));
    history.lastUpdated = new Date().toISOString().split('T')[0];
    fs.mkdirSync(path.dirname(CONFIG.HISTORY_FILE), { recursive: true });
    fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2));
    
    console.log('✅ 任务完成');
    
  } catch (error) {
    console.error('❌ 任务失败:', error);
    process.exit(1);
  }
}

main();
