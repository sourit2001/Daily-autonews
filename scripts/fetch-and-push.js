const https = require('https');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const CONFIG = {
  FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK,
  MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
  HISTORY_FILE: path.join(__dirname, '../memory/car-news-pushed.json'),
  BATCH_SIZE: 5,
  // 关键词：用于筛选新车、销量、技术、AI相关新闻
  KEYWORDS: [
    '新车', '上市', '首发', '亮相', '预售', '发布', '售价', '价格',
    '销量', '交付', '订单', '万台', '万辆',
    '技术', '智驾', '自动驾驶', '芯片', '电池', '续航', '充电', '800V', '固态电池',
    '小米', '比亚迪', '特斯拉', '问界', '华为', '理想', '蔚来', '小鹏', '极氪', '智界',
    '奔驰', '宝马', '奥迪', '大众', '丰田'
  ]
};

// 新闻源配置
const NEWS_SOURCES = [
  {
    name: '汽车之家',
    url: 'https://www.autohome.com.cn/all/',
    selector: 'a[href*="/news/202602/"]',
    extract: ($, elem) => {
      const href = $(elem).attr('href');
      const title = $(elem).text().trim();
      if (!href || !title || title.length < 10 || title.length > 100) return null;
      if (title.includes('广告') || title.includes('专题') || title.includes('精选')) return null;
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

// HTTP GET
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : require('http');
    client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...headers
      },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
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
      try {
        const news = source.extract($, elem);
        if (news && !newsList.find(n => n.url === news.url)) {
          newsList.push(news);
        }
      } catch (e) {}
    });
    
    console.log(`  ✅ ${source.name}: 获取 ${newsList.length} 条`);
    return newsList;
  } catch (e) {
    console.log(`  ❌ ${source.name}: ${e.message}`);
    return [];
  }
}

// 关键词过滤
function filterByKeywords(newsList) {
  return newsList.filter(news => {
    const text = `${news.title}`.toLowerCase();
    return CONFIG.KEYWORDS.some(keyword => 
      text.includes(keyword.toLowerCase())
    );
  });
}

// 抓取新闻详情生成摘要
async function fetchNewsDetail(url) {
  try {
    const html = await httpGet(url);
    const $ = cheerio.load(html);
    const paragraphs = $('.article-content p, .post-content p, .content p').map((_, el) => $(el).text().trim()).get();
    const content = paragraphs.slice(0, 3).join(' ').slice(0, 300);
    return content || '';
  } catch (e) {
    return '';
  }
}

// 使用 Kimi 生成单条摘要
async function generateSummary(title, content) {
  if (!CONFIG.MOONSHOT_API_KEY || !content) {
    return title;
  }
  
  const prompt = `为以下汽车新闻标题生成一句话摘要（30-50字），突出关键数据（价格、续航、销量、动力等）：

标题：${title}
内容：${content.slice(0, 400)}

直接输出摘要，不要其他内容。`;

  try {
    const response = await new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        model: 'moonshot-v1-8k',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        max_tokens: 100
      });
      
      const req = https.request('https://api.moonshot.cn/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.MOONSHOT_API_KEY}`,
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 30000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => reject(new Error('timeout')));
      req.write(postData);
      req.end();
    });

    if (response?.choices?.[0]) {
      return response.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
    }
  } catch (e) {
    console.log(`  ⚠️ 摘要生成失败: ${e.message}`);
  }
  return title;
}

// 发送飞书消息
async function sendToFeishu(batchNum, totalBatches, newsItems, dateStr) {
  const elements = [];
  
  if (batchNum === 1) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**📅 ${dateStr} | 汽车早报**\n\n📊 今日共 **${totalBatches * CONFIG.BATCH_SIZE}** 条新增资讯\n📌 全部新闻 · 无一遗漏`
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
    if (!CONFIG.FEISHU_WEBHOOK) {
      throw new Error('缺少 FEISHU_WEBHOOK 环境变量');
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

    console.log(`\n📊 总计获取: ${allNews.length} 条`);

    if (allNews.length === 0) {
      console.log('⚠️ 今日暂无新闻');
      return;
    }

    // 去重
    const uniqueNews = allNews.filter(n => !history.pushedUrls.includes(n.url));
    console.log(`📊 去重后: ${uniqueNews.length} 条`);

    if (uniqueNews.length === 0) {
      console.log('✅ 所有新闻已推送过');
      return;
    }

    // 关键词过滤（保留所有符合条件的新闻，不限制数量）
    console.log('\n🔍 按关键词过滤...');
    const filteredNews = filterByKeywords(uniqueNews);
    console.log(`📊 过滤后保留: ${filteredNews.length} 条`);

    if (filteredNews.length === 0) {
      console.log('⚠️ 今日无符合条件的新闻');
      return;
    }

    // 为每条新闻生成摘要
    console.log('\n🤖 正在生成摘要...');
    for (let i = 0; i < filteredNews.length; i++) {
      const news = filteredNews[i];
      console.log(`  [${i + 1}/${filteredNews.length}] ${news.title.slice(0, 40)}...`);
      
      if (CONFIG.MOONSHOT_API_KEY) {
        const content = await fetchNewsDetail(news.url);
        news.summary = await generateSummary(news.title, content);
      } else {
        news.summary = news.title;
      }
      
      await new Promise(r => setTimeout(r, 300));
    }

    // 分批处理
    const batches = [];
    for (let i = 0; i < filteredNews.length; i += CONFIG.BATCH_SIZE) {
      batches.push(filteredNews.slice(i, i + CONFIG.BATCH_SIZE));
    }

    console.log(`\n📤 准备推送 ${filteredNews.length} 条新闻，共${batches.length}页...`);

    // 逐批推送到飞书
    const dateStr = `${new Date().getMonth() + 1}月${new Date().getDate()}日`;
    for (let i = 0; i < batches.length; i++) {
      await sendToFeishu(i + 1, batches.length, batches[i], dateStr);
      if (i < batches.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // 更新历史记录
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
