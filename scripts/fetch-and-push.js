const https = require('https');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const CONFIG = {
  FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK,
  MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
  HISTORY_FILE: path.join(__dirname, '../memory/car-news-pushed.json'),
  MAX_NEWS: 12,  // 每天最多12条
};

// 热门品牌权重（用于排序）
const HOT_BRANDS = [
  '小米', '特斯拉', '比亚迪', '问界', '华为', '理想', '蔚来', '小鹏', '极氪', '智界',
  '奔驰', '宝马', '奥迪', '大众', '丰田', '本田', '日产', '福特', '通用',
  '吉利', '长城', '长安', '奇瑞', '传祺', '领克', '坦克', '方程豹'
];

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
      // 排除广告和导航
      if (title.includes('广告') || title.includes('专题') || title.includes('精选')) return null;
      const fullUrl = href.startsWith('http') ? href : `https:${href}`;
      return { title, url: fullUrl, source: '汽车之家', timestamp: Date.now() };
    }
  },
  {
    name: '懂车帝',
    url: 'https://www.dongchedi.com/square/forum/all',
    selector: 'a[href*="/article/"]',
    extract: ($, elem) => {
      const href = $(elem).attr('href');
      const title = $(elem).find('h2, .title, span').first().text().trim();
      if (!href || !title || title.length < 10) return null;
      const fullUrl = href.startsWith('http') ? href : `https://www.dongchedi.com${href}`;
      return { title, url: fullUrl, source: '懂车帝', timestamp: Date.now() };
    }
  },
  {
    name: '易车',
    url: 'https://www.yiche.com/xinwen/',
    selector: 'a[href*="/xinwen/"], a[href*="/news/"]',
    extract: ($, elem) => {
      const href = $(elem).attr('href');
      const title = $(elem).text().trim();
      if (!href || !title || title.length < 10) return null;
      const fullUrl = href.startsWith('http') ? href : `https://www.yiche.com${href}`;
      return { title, url: fullUrl, source: '易车', timestamp: Date.now() };
    }
  }
];

// HTTP GET
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, {
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

// HTTP POST
function httpPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const req = https.request(url, {
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
      try {
        const news = source.extract($, elem);
        if (news && !newsList.find(n => n.url === news.url)) {
          // 计算热度分数
          news.hotScore = 0;
          HOT_BRANDS.forEach((brand, idx) => {
            if (news.title.includes(brand)) {
              news.hotScore += (HOT_BRANDS.length - idx);
            }
          });
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

// 使用 Kimi AI 筛选重要新闻并生成摘要
async function aiSelectAndSummarize(newsItems) {
  console.log('\n🤖 使用 AI 筛选重要新闻...');
  
  const newsText = newsItems.map((item, index) => {
    return `${index + 1}. 【${item.source}】${item.title} (热度:${item.hotScore})`;
  }).join('\n');

  const prompt = `你是资深汽车媒体主编，拥有10年行业经验。请从以下新闻中选出今日最重要的 ${CONFIG.MAX_NEWS} 条。

【筛选标准】（按优先级排序）：
1. **热门品牌优先**：小米、特斯拉、比亚迪、华为/问界、理想、蔚来、极氪、BBA（奔驰宝马奥迪）、大众、丰田
2. **重要程度**：新车上市/首发 > 销量数据 > 技术发布 > 价格调整 > 其他资讯
3. **市场关注度**：消费者关注度高、社交媒体讨论度高的车型
4. **时效性**：今日最新发布的信息

【输出要求】
对选中的每条新闻：
1. 生成一个简洁有力的标题（15字以内）
2. 用一句话概括核心内容（30-50字），必须包含：
   - 具体车型/品牌
   - 关键数据（价格、续航、销量、时间等）
   - 核心价值/亮点
3. 标注来源

【新闻列表】
${newsText}

请按以下JSON格式输出：
{
  "selected_news": [
    {
      "original_index": 1,
      "title": "新标题",
      "summary": "一句话核心概括，包含关键数据",
      "sources": ["汽车之家", "懂车帝"]
    }
  ]
}

注意：
- 优先选择热门品牌的重要车型
- 不要选择边缘品牌或冷门车型
- 确保每条摘要都有具体数据支撑`;

  try {
    const response = await httpPost('https://api.moonshot.cn/v1/chat/completions', {
      model: 'moonshot-v1-8k',
      messages: [
        { role: 'system', content: '你是专业的汽车媒体主编，擅长识别重要汽车资讯，生成精炼的行业早报。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 2000
    }, {
      'Authorization': `Bearer ${CONFIG.MOONSHOT_API_KEY}`
    });

    if (response.choices && response.choices[0]) {
      const content = response.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        return result.selected_news || [];
      }
    }
    return [];
  } catch (e) {
    console.error('❌ AI 筛选失败:', e.message);
    return null;
  }
}

// 发送飞书消息
async function sendToFeishu(newsItems, dateStr) {
  const elements = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**📅 ${dateStr} | 汽车早报精选**\n\n📊 今日精选 **${newsItems.length}** 条重要资讯\n🔥 聚焦：热门品牌 · 新车上市 · 技术突破`
      }
    },
    { tag: 'hr' }
  ];

  newsItems.forEach((news, index) => {
    const sourceStr = news.sources ? news.sources.join(' · ') : news.source || '汽车之家';
    
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${index + 1}. ${news.title}**\n\n💡 **重点概览：**\n${news.summary}\n\n<font color="grey">📎 ${sourceStr} ${news.url ? `| [阅读全文 →](${news.url})` : ''}</font>`
      }
    });
    
    if (index < newsItems.length - 1) {
      elements.push({ tag: 'hr' });
    }
  });

  elements.push({
    tag: 'note',
    elements: [
      { tag: 'plain_text', content: '📌 数据来源：汽车之家 · 懂车帝 · 易车\n⚠️ 内容仅供参考，以官方发布为准' }
    ]
  });

  const card = {
    config: { wide_screen_mode": true },
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

    // 按热度排序
    uniqueNews.sort((a, b) => b.hotScore - a.hotScore);
    console.log(`\n🔥 热度最高: ${uniqueNews[0]?.title?.slice(0, 30)}...`);

    // 使用 AI 筛选重要新闻（传入前30条）
    const topNews = uniqueNews.slice(0, 30);
    const selectedNews = await aiSelectAndSummarize(topNews);

    if (!selectedNews || selectedNews.length === 0) {
      console.log('⚠️ AI 筛选失败，使用热度排序前12条');
      // 备用方案
      const finalNews = uniqueNews.slice(0, CONFIG.MAX_NEWS).map(n => ({
        title: n.title.slice(0, 20),
        summary: n.title,
        source: n.source,
        url: n.url
      }));
      
      const dateStr = `${new Date().getMonth() + 1}月${new Date().getDate()}日`;
      await sendToFeishu(finalNews, dateStr);
      
      // 更新历史
      history.pushedUrls.push(...finalNews.map(n => n.url));
      history.lastUpdated = new Date().toISOString().split('T')[0];
      fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2));
      
      console.log('\n✅ 任务完成（备用方案）');
      return;
    }

    // 映射回完整的URL
    const finalNews = selectedNews.map(item => {
      const original = topNews[item.original_index - 1];
      return {
        title: item.title,
        summary: item.summary,
        sources: item.sources || [original?.source || '汽车之家'],
        url: original?.url
      };
    });

    console.log(`\n📤 准备推送 ${finalNews.length} 条精选新闻...`);

    // 推送到飞书
    const dateStr = `${new Date().getMonth() + 1}月${new Date().getDate()}日`;
    await sendToFeishu(finalNews, dateStr);

    // 更新历史记录
    history.pushedUrls.push(...finalNews.map(n => n.url));
    history.lastUpdated = new Date().toISOString().split('T')[0];
    fs.mkdirSync(path.dirname(CONFIG.HISTORY_FILE), { recursive: true });
    fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2));

    console.log('\n✅ 任务完成');
    console.log(`📊 今日推送: ${finalNews.length} 条精选新闻`);

  } catch (error) {
    console.error('\n❌ 任务失败:', error.message);
    process.exit(1);
  }
}

main();
