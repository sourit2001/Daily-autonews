const https = require('https');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const CONFIG = {
  FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK,
  MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
  HISTORY_FILE: path.join(__dirname, '../memory/car-news-pushed.json'),
  BATCH_SIZE: 10,
  // 分类关键词
  CATEGORIES: {
    '电气化': [
      // 新能源车类型
      '纯电', '插混', '混动', 'PHEV', 'HEV', 'EV', '增程', '新能源', '电动',
      // 电池相关
      '电池', '续航', '充电', '800V', '高压', '固态电池', 'CTB', '碳化硅',
      // 电驱系统
      '电机', '电控', '电驱', '热泵', '能量回收',
      // 车型
      'e-tron', '双电机', '四驱', '零跑', '蔚来', '小鹏', '理想', '比亚迪', '特斯拉'
    ],
    '智能化': [
      // 智舱
      '智能座舱', '座舱', '车机', '语音', 'HUD', '屏幕', '芯片', '骁龙', '8295', '8155',
      // 智驾
      '智驾', '自动驾驶', '辅助驾驶', 'ADAS', 'NOA', '城市领航', '高速领航', '自动泊车',
      // 感知硬件
      '激光雷达', '毫米波雷达', '摄像头', '超声波', '感知', '传感器',
      // AI相关
      'AI', '人工智能', '算法', '大模型', '端到端', '视觉', '神经网络', '深度学习',
      // OTA和软件
      'OTA', '软件', '系统', '升级'
    ],
    '国际化': [
      // 中国公司出海
      '出海', '出口', '海外', '全球化', '国际', '进军', '登陆', '亮相', '发布',
      // 海外市场
      '欧洲', '欧盟', '德国', '法国', '英国', '意大利', '西班牙',
      '美国', '北美', '加拿大', '墨西哥',
      '日本', '韩国', '东南亚', '泰国', '新加坡', '马来西亚', '印尼',
      '澳洲', '澳大利亚', '新西兰',
      '中东', '迪拜', '沙特', '以色列',
      '南美', '巴西', '阿根廷', '智利',
      '俄罗斯', '印度', '土耳其', '南非',
      // 关税政策
      '关税', '贸易', '壁垒', '准入', '认证', '欧盟认证', 'WVTA',
      // 海外建厂
      '建厂', '工厂', '本地化', '本土化', 'KD', 'CKD', 'SKD',
      // 海外品牌进入中国
      '进口', '引入', '落地', '国产', '合资',
      // 海外品牌动态
      '宝马', '奔驰', '奥迪', '大众', '保时捷', '丰田', '本田', '日产', '现代', '起亚', '福特', '通用', '沃尔沃', '捷豹', '路虎', '特斯拉'
    ]
  }
};

// 获取今天的日期字符串 (YYYYMMDD)
function getTodayStr() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

// 获取今天的日期用于显示
function getDisplayDate() {
  const now = new Date();
  return `${now.getMonth() + 1}月${now.getDate()}日`;
}

// 解析日期字符串为时间戳
function parseDate(dateStr) {
  // 尝试多种格式
  const formats = [
    /(\d{4})-(\d{1,2})-(\d{1,2})/,  // 2026-02-11
    /(\d{4})\/(\d{1,2})\/(\d{1,2})/,  // 2026/02/11
    /(\d{4})年(\d{1,2})月(\d{1,2})日/, // 2026年02月11日
    /(\d{1,2})月(\d{1,2})日/, // 02月11日
  ];
  
  for (const format of formats) {
    const match = dateStr.match(format);
    if (match) {
      if (match.length === 4) {
        return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3])).getTime();
      } else if (match.length === 3) {
        // 没有年份，使用当前年份
        const now = new Date();
        return new Date(now.getFullYear(), parseInt(match[1]) - 1, parseInt(match[2])).getTime();
      }
    }
  }
  return null;
}

// 新闻源配置
const NEWS_SOURCES = [
  {
    name: '第一电动',
    url: 'https://www.d1ev.com/',
    selector: 'a[href*="/news/"], a[href*="/carnews/"], a[href*="/pingce/"], a[href*="/shichang/"]',
    extract: ($, elem) => {
      const href = $(elem).attr('href');
      const title = $(elem).text().trim();
      if (!href || !title || title.length < 10 || title.length > 100) return null;
      if (title.includes('广告') || title.includes('专题') || title.includes('推荐') || title.includes('加载更多')) return null;
      
      // 获取发布时间（如果页面中有）
      const timeElem = $(elem).closest('li, div, article').find('.time, .date, .publish-time, span[class*="time"]').first();
      const publishTime = timeElem.text().trim();
      
      const fullUrl = href.startsWith('http') ? href : `https://www.d1ev.com${href}`;
      return { title, url: fullUrl, source: '第一电动', publishTime };
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

// 分类新闻
function categorizeNews(newsList) {
  const categorized = {
    '电气化': [],
    '智能化': [],
    '国际化': [],
    '其他': []
  };

  newsList.forEach(news => {
    const text = news.title.toLowerCase();
    let assigned = false;

    // 检查每个分类
    for (const [category, keywords] of Object.entries(CONFIG.CATEGORIES)) {
      if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
        categorized[category].push(news);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      categorized['其他'].push(news);
    }
  });

  return categorized;
}

// 抓取新闻详情生成摘要
async function fetchNewsDetail(url) {
  try {
    const html = await httpGet(url);
    const $ = cheerio.load(html);
    const paragraphs = $('.article-content p, .post-content p, .content p').map((_, el) => $(el).text().trim()).get();
    const content = paragraphs.slice(0, 3).join(' ').slice(0, 400);
    return content || '';
  } catch (e) {
    return '';
  }
}

// 使用 Kimi 生成摘要
async function generateSummary(title, content) {
  if (!CONFIG.MOONSHOT_API_KEY || !content) {
    return title;
  }
  
  const prompt = `为以下汽车新闻生成一句话摘要（30-50字），突出关键数据：

标题：${title}
内容：${content.slice(0, 500)}

直接输出摘要。`;

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

// 发送飞书消息（按分类）
async function sendToFeishu(categorizedNews, dateStr) {
  const elements = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**📅 ${dateStr} | 汽车早报**\n\n📊 今日新闻分类汇总\n⚡ 电气化 · 🤖 智能化 · 🌍 国际化`
      }
    },
    { tag: 'hr' }
  ];

  const categories = ['电气化', '智能化', '国际化', '其他'];
  const emojis = { '电气化': '⚡', '智能化': '🤖', '国际化': '🌍', '其他': '📰' };
  
  let globalIndex = 0;

  for (const category of categories) {
    const newsList = categorizedNews[category];
    if (newsList.length === 0) continue;

    // 分类标题
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${emojis[category]} ${category}（${newsList.length}条）**`
      }
    });

    // 该分类的新闻
    newsList.forEach((news, idx) => {
      globalIndex++;
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${globalIndex}. ${news.title}**\n> ${news.summary}\n<font color="grey">📎 ${news.source} | [阅读全文 →](${news.url})</font>`
        }
      });
      
      if (idx < newsList.length - 1) {
        elements.push({ tag: 'div', text: { tag: 'plain_text', content: '' } });
      }
    });

    elements.push({ tag: 'hr' });
  }

  elements.push({
    tag: 'note',
    elements: [
      { tag: 'plain_text', content: `📌 数据来源：第一电动\n📊 总计：${globalIndex} 条新闻\n⚠️ 内容仅供参考，以官方发布为准` }
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

    // 日期过滤：保留24小时内的新闻
    console.log(`\n📅 今天日期: ${getDisplayDate()}`);
    console.log('🔍 按日期过滤，保留24小时内的新闻...');
    
    const recentNews = [];
    const now = Date.now();
    const hours24 = 24 * 60 * 60 * 1000; // 24小时毫秒数
    
    for (const news of uniqueNews) {
      // 尝试抓取新闻详情页获取准确发布时间
      try {
        const detailHtml = await httpGet(news.url);
        const $ = cheerio.load(detailHtml);
        
        // 尝试多种时间选择器
        let publishTime = $('.time, .date, .publish-time, .article-time, [class*="time"]').first().text().trim();
        
        // 如果没有找到，尝试从页面内容中匹配日期格式
        if (!publishTime) {
          const pageText = $('body').text();
          const dateMatch = pageText.match(/(\d{4}[\-\/年]\d{1,2}[\-\/月]\d{1,2})/);
          if (dateMatch) {
            publishTime = dateMatch[1];
          }
        }
        
        // 解析日期并检查是否在24小时内
        let isRecent = true;
        let publishTimestamp = null;
        
        if (publishTime) {
          publishTimestamp = parseDate(publishTime);
          if (publishTimestamp) {
            const diff = now - publishTimestamp;
            isRecent = diff <= hours24;
          }
        }
        
        if (isRecent) {
          news.publishTime = publishTime || '24小时内';
          recentNews.push(news);
        } else {
          const dateStr = publishTimestamp ? new Date(publishTimestamp).toLocaleDateString('zh-CN') : publishTime;
          console.log(`  ⏭️ 跳过旧新闻: ${news.title.slice(0, 30)}... (${dateStr})`);
        }
        
        // 延迟避免请求过快
        await new Promise(r => setTimeout(r, 200));
        
      } catch (e) {
        // 如果抓取失败，默认保留
        news.publishTime = '24小时内';
        recentNews.push(news);
      }
    }
    
    console.log(`📊 24小时内新闻: ${recentNews.length} 条`);

    if (recentNews.length === 0) {
      console.log('⚠️ 24小时内暂无新新闻');
      return;
    }

    // 分类
    console.log('\n📂 正在分类新闻...');
    const categorized = categorizeNews(recentNews);
    
    const totalNews = Object.values(categorized).flat().length;
    console.log(`📊 分类完成: 共${totalNews}条`);
    console.log(`  ⚡ 电气化: ${categorized['电气化'].length}条`);
    console.log(`  🤖 智能化: ${categorized['智能化'].length}条`);
    console.log(`  🌍 国际化: ${categorized['国际化'].length}条`);
    console.log(`  📰 其他: ${categorized['其他'].length}条`);

    if (totalNews === 0) {
      console.log('⚠️ 今日无符合条件的新闻');
      return;
    }

    // 为每条新闻生成摘要
    console.log('\n🤖 正在生成摘要...');
    for (const category of Object.keys(categorized)) {
      for (let i = 0; i < categorized[category].length; i++) {
        const news = categorized[category][i];
        console.log(`  [${category}] ${news.title.slice(0, 35)}...`);
        
        if (CONFIG.MOONSHOT_API_KEY) {
          const content = await fetchNewsDetail(news.url);
          news.summary = await generateSummary(news.title, content);
        } else {
          news.summary = news.title;
        }
        
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // 推送到飞书
    console.log('\n📤 正在推送到飞书...');
    const dateStr = `${new Date().getMonth() + 1}月${new Date().getDate()}日`;
    await sendToFeishu(categorized, dateStr);

    // 更新历史记录
    const allPushed = Object.values(categorized).flat();
    history.pushedUrls.push(...allPushed.map(n => n.url));
    history.lastUpdated = new Date().toISOString().split('T')[0];
    fs.mkdirSync(path.dirname(CONFIG.HISTORY_FILE), { recursive: true });
    fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2));

    console.log('\n✅ 任务完成');
    console.log(`📊 今日推送: ${allPushed.length} 条今日新闻（已分类）`);

  } catch (error) {
    console.error('\n❌ 任务失败:', error.message);
    process.exit(1);
  }
}

main();
