const https = require('https');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const CONFIG = {
  FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK,
  MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
  HISTORY_FILE: path.join(__dirname, '../memory/car-news-pushed.json'),
  BATCH_SIZE: 5,
  // 只关注的新闻类别关键词
  KEYWORDS: ['新车', '上市', '首发', '亮相', '预售', '发布', '销量', '交付', '订单',
             '技术', '智驾', '自动驾驶', 'AI', '智能', '芯片', '电池', '续航', '充电',
             '降价', '涨价', '优惠', '补贴', '固态电池', 'CTB', '800V', '激光雷达']
};

// 新闻源配置
const NEWS_SOURCES = [
  {
    name: '汽车之家',
    url: 'https://www.autohome.com.cn/all/',
    type: 'html',
    selector: 'a[href*="/news/"]',
    extract: ($, elem) => {
      const href = $(elem).attr('href');
      const title = $(elem).text().trim();
      if (!href || !title || title.length < 10) return null;
      const fullUrl = href.startsWith('http') ? href : `https:${href}`;
      return { title, url: fullUrl, source: '汽车之家' };
    }
  },
  {
    name: '懂车帝',
    url: 'https://www.dongchedi.com/',
    type: 'html',
    selector: 'a[href*="/article/"]',
    extract: ($, elem) => {
      const href = $(elem).attr('href');
      const title = $(elem).text().trim();
      if (!href || !title || title.length < 10) return null;
      const fullUrl = href.startsWith('http') ? href : `https://www.dongchedi.com${href}`;
      return { title, url: fullUrl, source: '懂车帝' };
    }
  },
  {
    name: '易车',
    url: 'https://www.yiche.com/',
    type: 'html',
    selector: 'a[href*="/xinwen/"], a[href*="/news/"], a[href*="/article/"]',
    extract: ($, elem) => {
      const href = $(elem).attr('href');
      const title = $(elem).text().trim();
      if (!href || !title || title.length < 10) return null;
      const fullUrl = href.startsWith('http') ? href : `https://www.yiche.com${href}`;
      return { title, url: fullUrl, source: '易车' };
    }
  }
];

// HTTP 请求
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : require('http');
    client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...headers
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

// POST 请求
function httpPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const client = url.startsWith('https') ? https : require('http');
    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers
      },
      timeout: 60000
    }, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseData));
        } catch (e) {
          resolve(responseData);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('timeout')));
    req.write(postData);
    req.end();
  });
}

// 过滤新闻：只保留关注的关键词相关新闻
function filterNewsByKeywords(newsList) {
  return newsList.filter(news => {
    const text = `${news.title} ${news.source}`.toLowerCase();
    return CONFIG.KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()));
  });
}

// 从单个源抓取新闻
async function fetchFromSource(source) {
  console.log(`📰 正在抓取: ${source.name}...`);
  try {
    const html = await httpGet(source.url);
    const $ = cheerio.load(html);
    const newsList = [];
    
    $(source.selector).each((_, elem) => {
      const news = source.extract($, elem);
      if (news && !newsList.find(n => n.url === news.url)) {
        newsList.push(news);
      }
    });
    
    console.log(`  ✅ ${source.name}: 获取 ${newsList.length} 条`);
    return newsList;
  } catch (e) {
    console.log(`  ❌ ${source.name}: ${e.message}`);
    return [];
  }
}

// 抓取单条新闻详情
async function fetchNewsContent(url) {
  try {
    const html = await httpGet(url);
    const $ = cheerio.load(html);
    const content = $('.article-content, .post-content, .content, [class*="content"]').text().trim();
    return content.slice(0, 800) || '';
  } catch (e) {
    return '';
  }
}

// 使用 Kimi API 生成单条摘要
async function generateSummary(title, content, url) {
  if (!content || content.length < 50) {
    return { summary: title, url };
  }

  const prompt = `请为以下汽车新闻生成一句话摘要（30-50字），突出核心数据（价格、续航、功率、销量等）和亮点：

标题：${title}
内容：${content.slice(0, 500)}

要求：
- 一句话概括
- 包含关键数字
- 突出新闻价值

直接输出摘要，不要其他内容。`;

  try {
    const response = await httpPost('https://api.moonshot.cn/v1/chat/completions', {
      model: 'moonshot-v1-8k',
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0.5,
      max_tokens: 100
    }, {
      'Authorization': `Bearer ${CONFIG.MOONSHOT_API_KEY}`
    });

    if (response.choices && response.choices[0]) {
      let summary = response.choices[0].message.content.trim();
      // 移除引号
      summary = summary.replace(/^["']|["']$/g, '');
      return { summary, url };
    }
  } catch (e) {
    console.log(`  ⚠️ 摘要生成失败: ${e.message}`);
  }
  
  return { summary: title, url };
}

// 发送飞书卡片消息
async function sendToFeishu(batchNum, totalBatches, newsItems) {
  const today = new Date();
  const dateStr = `${today.getMonth() + 1}月${today.getDate()}日`;
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][today.getDay()];
  
  const elements = [];
  
  if (batchNum === 1) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**📅 ${dateStr} 周${weekday} | 汽车早报**\n\n📊 今日共 **${totalBatches * CONFIG.BATCH_SIZE}** 条新增资讯\n📌 点击标题查看原文`
      }
    });
    elements.push({ tag: 'hr' });
  }
  
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**📑 第 ${batchNum}/${totalBatches} 页**`
    }
  });

  newsItems.forEach((news, index) => {
    const globalIndex = (batchNum - 1) * CONFIG.BATCH_SIZE + index + 1;
    
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${globalIndex}. ${news.title}**\n\n💡 **重点概览：**\n${news.summary}\n\n<font color="grey">📎 ${news.source} | [阅读全文 →](${news.url})</font>`
      }
    });
    
    if (index < newsItems.length - 1) {
      elements.push({ tag: 'hr' });
    }
  });

  if (batchNum === totalBatches) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'note',
      elements: [
        { tag: 'plain_text', content: '📌 数据来源：汽车之家 · 懂车帝 · 易车\n⚠️ 内容仅供参考，以官方发布为准' }
      ]
    });
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📰 汽车早报 | ${dateStr} · 第${batchNum}页` },
      template: 'blue'
    },
    elements
  };

  const data = JSON.stringify({ msg_type: 'interactive', card });

  return new Promise((resolve, reject) => {
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
            console.log(`✅ 第${batchNum}页发送成功`);
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

// 主函数
async function main() {
  console.log('🚀 每日汽车新闻推送开始');
  console.log(`📅 时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log('=' .repeat(50));

  try {
    // 检查配置
    if (!CONFIG.FEISHU_WEBHOOK) {
      throw new Error('缺少 FEISHU_WEBHOOK 环境变量');
    }
    if (!CONFIG.MOONSHOT_API_KEY) {
      throw new Error('缺少 MOONSHOT_API_KEY 环境变量');
    }

    // 读取历史记录
    let history = { pushedUrls: [], lastUpdated: '' };
    if (fs.existsSync(CONFIG.HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(CONFIG.HISTORY_FILE, 'utf8'));
    }

    // 从多个源抓取新闻
    console.log('\n📡 开始抓取多源新闻...');
    const allNews = [];
    for (const source of NEWS_SOURCES) {
      const news = await fetchFromSource(source);
      allNews.push(...news);
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`\n📊 总计获取: ${allNews.length} 条新闻`);

    if (allNews.length === 0) {
      console.log('⚠️ 今日暂无新闻');
      return;
    }

    // 去重（基于URL）
    const uniqueNews = allNews.filter(n => !history.pushedUrls.includes(n.url));
    console.log(`📊 去重后新新闻: ${uniqueNews.length} 条`);

    if (uniqueNews.length === 0) {
      console.log('✅ 所有新闻已推送过');
      return;
    }

    // 按关键词过滤：只保留新车、销量、技术、AI相关新闻
    console.log('\n🔍 按关键词过滤（新车/销量/技术/AI）...');
    const filteredNews = filterNewsByKeywords(uniqueNews);
    console.log(`📊 过滤后保留: ${filteredNews.length} 条`);

    if (filteredNews.length === 0) {
      console.log('⚠️ 今日无符合条件的新闻（新车/销量/技术/AI）');
      return;
    }

    // 为每条新闻抓取内容并生成摘要
    console.log('\n🤖 正在为每条新闻生成摘要...');
    for (let i = 0; i < filteredNews.length; i++) {
      const news = filteredNews[i];
      console.log(`  [${i + 1}/${filteredNews.length}] ${news.title.slice(0, 30)}...`);
      
      const content = await fetchNewsContent(news.url);
      const summaryResult = await generateSummary(news.title, content, news.url);
      
      news.summary = summaryResult.summary;
      await new Promise(r => setTimeout(r, 500)); // 避免请求过快
    }

    // 分批处理（每批5条）
    const batches = [];
    for (let i = 0; i < filteredNews.length; i += CONFIG.BATCH_SIZE) {
      batches.push(filteredNews.slice(i, i + CONFIG.BATCH_SIZE));
    }

    console.log(`\n📤 准备推送 ${batches.length} 页消息...`);

    // 逐批推送到飞书
    for (let i = 0; i < batches.length; i++) {
      await sendToFeishu(i + 1, batches.length, batches[i]);
      if (i < batches.length - 1) {
        await new Promise(r => setTimeout(r, 1500)); // 批间延迟
      }
    }

    // 更新历史记录（只记录已推送的过滤后新闻）
    history.pushedUrls.push(...filteredNews.map(n => n.url));
    history.lastUpdated = new Date().toISOString().split('T')[0];
    fs.mkdirSync(path.dirname(CONFIG.HISTORY_FILE), { recursive: true });
    fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2));

    console.log('\n✅ 任务完成');
    console.log(`📊 今日推送: ${filteredNews.length} 条新闻，共${batches.length}页`);

  } catch (error) {
    console.error('\n❌ 任务失败:', error.message);
    process.exit(1);
  }
}

main();
