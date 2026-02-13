const https = require('https');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const CONFIG = {
  FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
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

// 获取特定时区的时间
function getZonedDateTime() {
  // 强制使用北京时间 (UTC+8)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utc + (3600000 * 8));
}

// 获取今天的日期字符串 (YYYYMMDD)
function getTodayStr() {
  const bjNow = getZonedDateTime();
  const year = bjNow.getFullYear();
  const month = String(bjNow.getMonth() + 1).padStart(2, '0');
  const day = String(bjNow.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

// 获取今天的日期用于显示
function getDisplayDate() {
  const bjNow = getZonedDateTime();
  return `${bjNow.getMonth() + 1}月${bjNow.getDate()}日`;
}

// 解析日期字符串为时间戳
function parseDate(dateStr) {
  if (!dateStr) return null;

  // 清理字符串
  const cleanStr = dateStr.trim();

  // 尝试多种格式
  const formats = [
    { regex: /(\d{4})-(\d{1,2})-(\d{1,2})/, hasYear: true },  // 2026-02-11
    { regex: /(\d{4})\/(\d{1,2})\/(\d{1,2})/, hasYear: true },  // 2026/02/11
    { regex: /(\d{4})年(\d{1,2})月(\d{1,2})日/, hasYear: true }, // 2026年02月11日
    { regex: /(\d{1,2})月(\d{1,2})日/, hasYear: false }, // 02月11日
  ];

  for (const format of formats) {
    const match = cleanStr.match(format.regex);
    if (match) {
      let year, month, day;

      if (format.hasYear) {
        year = parseInt(match[1]);
        month = parseInt(match[2]) - 1; // 月份从0开始
        day = parseInt(match[3]);
      } else {
        // 没有年份，使用当前年份
        const now = new Date();
        year = now.getFullYear();
        month = parseInt(match[1]) - 1;
        day = parseInt(match[2]);
      }

      const date = new Date(year, month, day);
      // 验证日期是否有效
      if (date.getFullYear() === year && date.getMonth() === month && date.getDate() === day) {
        return date.getTime();
      }
    }
  }

  // 尝试直接解析（ISO格式等）
  const directParse = new Date(cleanStr);
  if (!isNaN(directParse.getTime())) {
    return directParse.getTime();
  }

  return null;
}

// 新闻源配置
const NEWS_SOURCES = [
  {
    name: '第一电动-快讯',
    url: 'https://www.d1ev.com/newsflash',
    selector: '.content-list li',
    extract: ($, elem) => {
      const $link = $(elem).find('.list-desc a');
      const href = $link.attr('href');
      const titleSnippet = $link.find('.desc-title').text().trim();
      if (!href) return null;

      // 快讯通常在列表页就有完整正文
      const fullText = $link.text().trim();
      // 去掉标题部分，剩下就是正文
      const content = fullText.replace(titleSnippet, '').trim();

      const title = titleSnippet.replace(/^【|】$/g, ''); // 去掉书名号
      const fullUrl = href.startsWith('http') ? href : `https://www.d1ev.com${href}`;

      return {
        title,
        url: fullUrl,
        source: '第一电动',
        content: content || null
      };
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
      } catch (e) { }
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
    '新车发布': [],
    '智能电气': [],
    '国际化': [],
    '其他': []
  };

  newsList.forEach(news => {
    const text = news.title.toLowerCase();
    let assigned = false;

    // 优先级1: 新车（标题含 曝光、上市、预售、申报、新车、谍照）
    const carKeywords = ['曝光', '上市', '预售', '申报', '新车', '谍照', '亮相', '官图', '首发'];
    if (carKeywords.some(kw => text.includes(kw))) {
      categorized['新车发布'].push(news);
      assigned = true;
    }

    // 优先级2: 智能化与电气化
    if (!assigned) {
      const techKeywords = ['ai', '智驾', '自动驾驶', '算法', '大模型', '端到端', '芯片', '座舱', '电池', '续航', '充电', '新能源', '电动'];
      if (techKeywords.some(kw => text.includes(kw))) {
        categorized['智能电气'].push(news);
        assigned = true;
      }
    }

    // 优先级3: 国际化
    if (!assigned) {
      const globalKeywords = ['出海', '出口', '海外', '全球', '国际', '漫游', '欧洲', '美国', '泰国', '关税'];
      if (globalKeywords.some(kw => text.includes(kw))) {
        categorized['国际化'].push(news);
        assigned = true;
      }
    }

    if (!assigned) {
      categorized['其他'].push(news);
    }
  });

  return categorized;
}

// 抓取新闻详情
async function fetchNewsDetail(url) {
  try {
    const html = await httpGet(url);
    const $ = cheerio.load(html);

    // 移除脚本和样式标签，避免提取到代码片段
    $('script, style, ins, .advert, .advertisement').remove();

    // 扩展选择器支持更多网站，特别是第一电动 (#showall233, .ws-newscon)
    const selectors = [
      '#showall233',
      '.ws-newscon',
      '.article-content',
      '.post-content',
      '.content',
      '.detail-content',
      '.article-body',
      '.main_content'
    ];

    let content = '';
    for (const selector of selectors) {
      const el = $(selector);
      if (el.length > 0) {
        // 优先获取段落
        const paragraphs = el.find('p').map((_, p) => $(p).text().trim()).get()
          .filter(txt => txt.length > 15); // 过滤掉太短的段落

        if (paragraphs.length > 0) {
          // 过滤掉包含广告或脚本信息的段落
          const filteredPs = paragraphs.filter(p =>
            !p.includes('addAdvertInfo') &&
            !p.includes('var ') &&
            !p.includes('window.') &&
            !p.includes('转载自') &&
            !p.includes('本文地址')
          );
          content = filteredPs.slice(0, 5).join('\n');
        } else {
          // 如果没有P标签，取纯文本并清理
          content = el.text().trim()
            .replace(/\s+/g, ' ')
            .replace(/addAdvertInfo\(.*?\);/g, '')
            .replace(/var .*?;/g, '');
        }

        if (content.length > 50) break;
      }
    }

    return content.slice(0, 1000) || '';
  } catch (e) {
    return '';
  }
}

// 使用 DeepSeek 生成摘要
async function generateSummary(title, content) {
  if (!CONFIG.DEEPSEEK_API_KEY) {
    return title;
  }

  // 针对EV晨报等特殊格式处理
  const isEVMorning = title.includes('EV晨报') || title.includes('早报');

  let prompt;
  if (isEVMorning && content) {
    // EV晨报格式：提取多条新闻
    prompt = `作为深耕汽车行业的资深分析师，请阅读以下【早报/晨报】内容，并进行精炼总结：
要求：
1. 提取3-5个最重要的核心动态。
2. 每个动态包含：【事实+影响】。事实需含核心数据；影响需简述其对行业或企业的意义（如：加剧价格战、补齐产品线短板、市场结构变化等）。
3. 总字数控制在200字以内，使用分号“；”分隔。

标题：${title}
正文内容：${content.slice(0, 1000)}

直接输出总结，不要带前缀。`;
  } else if (content && content.length > title.length + 20) {
    prompt = `你是一个拥有敏锐洞察力的汽车行业首席观察家。请为以下新闻提供一个【深度摘要】。

要求：
1. **不要复读标题，不要简单搬运原文**。
2. 结构建议为：关键核心事实（包含硬核数据） + 一句深度点评（分析其背后的行业趋势、竞争格局或潜在影响）。
3. 语言要老练、犀利，字数在60-100字之间。
4. 挖掘正文中不容易被发现的“干货”细节。

标题：${title}
正文片段：${content.slice(0, 800)}

请直接给出深度摘要内容。`;
  } else {
    // 只有标题的情况
    prompt = `作为汽车行业专家，请针对该标题提供一段有深度的背景分析或潜在趋势预测（50-80字）：
标题：${title}
直接输出内容。`;
  }

  try {
    const response = await new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 500
      });

      const req = https.request('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.DEEPSEEK_API_KEY}`,
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
      let summary = response.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
      // 对于EV晨报，清理格式
      if (isEVMorning) {
        summary = summary.replace(/^\d+\.\s*/gm, '').replace(/\n/g, '；').replace(/；；/g, '；');
      }
      return summary;
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
        content: `**📅 ${dateStr} | 汽车新闻速递**\n\n📊 实时动态汇总\n🚗 新车上市 · 🤖 智能电气 · 🌍 国际化`
      }
    },
    { tag: 'hr' }
  ];

  const categories = ['新车发布', '智能电气', '国际化', '其他'];
  const emojis = { '新车发布': '🚗', '智能电气': '🤖', '国际化': '🌍', '其他': '📰' };

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
      title: { tag: 'plain_text', content: `📰 新闻速递 | ${dateStr}` },
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
  console.log('='.repeat(50));

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

    // 标题关键词过滤：跳过榜单/排名类旧闻
    const skipKeywords = ['智驾天梯榜', '智驾大赛', '年度总榜', '年度奖项', '年度冠亚季军', '年度四小龙', '年度四大天王', '年度黑马', '年度榜单', '积分排行榜'];
    const filteredNews = uniqueNews.filter(news => {
      const shouldSkip = skipKeywords.some(kw => news.title.includes(kw));
      if (shouldSkip) {
        console.log(`  ⏭️ 跳过榜单类: ${news.title.slice(0, 35)}...`);
      }
      return !shouldSkip;
    });
    console.log(`📊 过滤后: ${filteredNews.length} 条（跳过${uniqueNews.length - filteredNews.length}条榜单类）`);

    if (filteredNews.length === 0) {
      console.log('⚠️ 过滤后无新闻可推送');
      return;
    }

    // 日期过滤：保留24小时内的新闻
    console.log(`\n📅 今天日期: ${getDisplayDate()}`);
    console.log('🔍 按日期过滤，保留24小时内的新闻...');

    const recentNews = [];
    const now = Date.now();
    const hours24 = 24 * 60 * 60 * 1000; // 24小时毫秒数

    for (const news of filteredNews) {
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
            const daysAgo = Math.floor(diff / (24 * 60 * 60 * 1000));
            isRecent = diff <= hours24 && diff >= -hours24; // 也排除未来时间

            if (!isRecent) {
              console.log(`  ⏭️ 跳过旧新闻: ${news.title.slice(0, 30)}... (发布于${daysAgo}天前: ${new Date(publishTimestamp).toLocaleDateString('zh-CN')})`);
            }
          }
        }

        if (isRecent) {
          news.publishTime = publishTime || '24小时内';
          recentNews.push(news);
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
    console.log(`  🚗 新车发布: ${categorized['新车发布'].length}条`);
    console.log(`  🤖 智能电气: ${categorized['智能电气'].length}条`);
    console.log(`  🌍 国际化: ${categorized['国际化'].length}条`);
    console.log(`  📰 其他: ${categorized['其他'].length}条`);

    if (totalNews === 0) {
      console.log('⚠️ 今日无符合条件的新闻');
      return;
    }

    // 提取正文内容
    console.log('\n📝 正在提取新闻内容...');
    for (const category of Object.keys(categorized)) {
      for (let i = 0; i < categorized[category].length; i++) {
        const news = categorized[category][i];

        // 优先使用列表中已抓取到的内容
        let content = news.content;

        if (!content) {
          console.log(`  [详情抓取] ${news.title.slice(0, 35)}...`);
          content = await fetchNewsDetail(news.url);
        } else {
          console.log(`  [直接获取] ${news.title.slice(0, 35)}...`);
        }

        // 使用 AI 为每条新闻生成深度摘要
        if (CONFIG.DEEPSEEK_API_KEY) {
          news.summary = await generateSummary(news.title, content);
        } else {
          news.summary = content ? content.slice(0, 100) + '...' : news.title;
        }

        await new Promise(r => setTimeout(r, 300));
      }
    }

    // 推送到飞书
    console.log('\n📤 正在推送到飞书...');
    const bjNow = getZonedDateTime();
    const dateStr = `${bjNow.getMonth() + 1}月${bjNow.getDate()}日 ${String(bjNow.getHours()).padStart(2, '0')}:${String(bjNow.getMinutes()).padStart(2, '0')}`;
    await sendToFeishu(categorized, dateStr);

    // 更新历史记录
    const allPushed = Object.values(categorized).flat();
    history.pushedUrls.push(...allPushed.map(n => n.url));
    history.lastUpdated = `${bjNow.getFullYear()}-${String(bjNow.getMonth() + 1).padStart(2, '0')}-${String(bjNow.getDate()).padStart(2, '0')}`;
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
