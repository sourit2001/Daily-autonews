const https = require('https');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const CONFIG = {
  FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK,
  MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
  HISTORY_FILE: path.join(__dirname, '../memory/car-news-pushed.json'),
  MAX_NEWS_PER_DAY: 9,  // 每日最多9条
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

// POST 请求（用于 Kimi API）
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
    return newsList.slice(0, 10);  // 每个源最多10条
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
    
    // 尝试多种正文选择器
    const content = $('.article-content, .post-content, .content, [class*="content"]').text().trim();
    return content.slice(0, 1000) || '';
  } catch (e) {
    return '';
  }
}

// 使用 Kimi API 生成摘要
async function generateSummaryWithKimi(newsItems) {
  console.log('\n🤖 使用 Kimi 生成摘要...');
  
  // 构建提示词
  const newsText = newsItems.map((item, index) => {
    return `${index + 1}. 【${item.source}】${item.title}
   链接: ${item.url}`;
  }).join('\n\n');

  const prompt = `你是资深汽车媒体主编，拥有10年行业经验。请从以下新闻中筛选并生成专业的汽车早报。

【筛选标准】
1. 优先级：新车发布 > 重磅改款 > 行业政策 > 市场数据 > 普通资讯
2. 必报内容：售价/续航/动力参数、上市时间、核心配置升级
3. 去重合并：同一车型/事件的不同来源报道合并为一条

【摘要要求】
每条新闻必须包含：
- 核心价值：为什么这条新闻值得关注？（如"同级唯一...""价格下探至..."）
- 关键数据：具体数字（价格、续航、功率、销量等）
- 时效标签：今日上午/下午/晚间

【输出格式】
请返回 ${CONFIG.MAX_NEWS_PER_DAY} 条精选新闻，JSON格式：
{
  "selected_news": [
    {
      "title": "简短有力的标题（15字内）",
      "summary": "50字内，包含：亮点+关键数据+意义",
      "sources": ["汽车之家", "懂车帝", "易车"],
      "time": "今日 XX:XX",
      "category": "新车/改款/政策/市场/技术"
    }
  ]
}

【新闻源】
${newsText}

请确保摘要信息密度高，读者看了就能抓住重点。`;

  try {
    const response = await httpPost('https://api.moonshot.cn/v1/chat/completions', {
      model: 'moonshot-v1-8k',
      messages: [
        { role: 'system', content: '你是专业的汽车新闻编辑，擅长提炼新闻核心信息，生成简洁有力的早报。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 2000
    }, {
      'Authorization': `Bearer ${CONFIG.MOONSHOT_API_KEY}`
    });

    if (response.choices && response.choices[0]) {
      const content = response.choices[0].message.content;
      // 提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        return result.selected_news || [];
      }
    }
    return [];
  } catch (e) {
    console.error('❌ Kimi API 调用失败:', e.message);
    return null;
  }
}

// 发送飞书消息
async function sendToFeishu(newsItems) {
  const today = new Date();
  const dateStr = `${today.getMonth() + 1}月${today.getDate()}日`;
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][today.getDay()];
  
  const elements = [];
  
  // 分类统计
  const categories = {};
  newsItems.forEach(news => {
    const cat = news.category || '资讯';
    categories[cat] = (categories[cat] || 0) + 1;
  });
  const catStr = Object.entries(categories).map(([k, v]) => `${k}${v}条`).join(' · ');
  
  // 头部信息
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**📅 ${dateStr} 周${weekday} | 汽车早报精选**\n\n📊 今日精选 **${newsItems.length}** 条重要资讯\n🏷️ ${catStr}\n\n💡 由 Kimi AI 分析整理，聚焦行业核心动态`
    }
  });
  elements.push({ tag: 'hr' });
  
  // 按类别分组展示
  const categoryOrder = ['新车', '改款', '技术', '政策', '市场', '资讯'];
  const grouped = {};
  newsItems.forEach(news => {
    const cat = news.category || '资讯';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(news);
  });
  
  categoryOrder.forEach(cat => {
    if (grouped[cat]) {
      // 类别标题
      const catEmoji = {
        '新车': '🚗', '改款': '✨', '技术': '🔧',
        '政策': '📋', '市场': '📈', '资讯': '📰'
      }[cat] || '📌';
      
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${catEmoji} ${cat}动态**`
        }
      });
      
      // 该类别的新闻
      grouped[cat].forEach((news, idx) => {
        const sourceStr = news.sources ? news.sources.join('·') : news.source || '汽车之家';
        const timeStr = news.time || '今日';
        
        elements.push({
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**${news.title}**\n> ${news.summary}\n\n<font color="grey">📎 ${sourceStr} · ⏱️ ${timeStr}</font>`
          }
        });
        
        if (idx < grouped[cat].length - 1) {
          elements.push({ tag: 'div', text: { tag: 'plain_text', content: '' } });
        }
      });
      
      elements.push({ tag: 'hr' });
    }
  });
  
  // 底部信息
  elements.push({
    tag: 'note',
    elements: [
      { tag: 'plain_text', content: '🤖 内容由 Kimi AI 智能分析生成\n📌 数据来自汽车之家·懂车帝·易车\n⚠️ 仅供参考，以官方发布为准' }
    ]
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📰 汽车早报 | ${dateStr}` },
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
            console.log('✅ 飞书推送成功');
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
      await new Promise(r => setTimeout(r, 1000)); // 延迟避免被封
    }

    console.log(`\n📊 总计获取: ${allNews.length} 条新闻`);

    if (allNews.length === 0) {
      console.log('⚠️ 今日暂无新闻');
      return;
    }

    // 去重（基于URL）
    const uniqueNews = allNews.filter(n => !history.pushedUrls.includes(n.url));
    console.log(`📊 去重后: ${uniqueNews.length} 条新新闻`);

    if (uniqueNews.length === 0) {
      console.log('✅ 所有新闻已推送过');
      return;
    }

    // 使用 Kimi 生成精选摘要
    const selectedNews = await generateSummaryWithKimi(uniqueNews);

    if (!selectedNews || selectedNews.length === 0) {
      console.log('⚠️ Kimi 生成摘要失败，使用原始数据');
      // 备用方案：直接使用原始标题
      for (const news of uniqueNews.slice(0, CONFIG.MAX_NEWS_PER_DAY)) {
        news.summary = '点击查看详情';
      }
    }

    const finalNews = selectedNews || uniqueNews.slice(0, CONFIG.MAX_NEWS_PER_DAY);

    // 推送到飞书
    console.log('\n📤 推送到飞书...');
    await sendToFeishu(finalNews);

    // 更新历史记录
    history.pushedUrls.push(...uniqueNews.map(n => n.url));
    history.lastUpdated = new Date().toISOString().split('T')[0];
    fs.mkdirSync(path.dirname(CONFIG.HISTORY_FILE), { recursive: true });
    fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2));

    console.log('\n✅ 任务完成');
    console.log(`📊 今日推送: ${finalNews.length} 条`);

  } catch (error) {
    console.error('\n❌ 任务失败:', error.message);
    process.exit(1);
  }
}

main();
