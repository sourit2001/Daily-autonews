const https = require('https');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const CONFIG = {
  FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'qwen/qwen3-32b:free',
  OPENROUTER_FALLBACK_MODELS: (process.env.OPENROUTER_FALLBACK_MODELS || process.env.OPENROUTER_FALLBACK_MODEL || 'minimax/minimax-m2.5:free,z-ai/glm-4.5-air:free')
    .split(',').map(model => model.trim()).filter(Boolean),
  SUMMARY_BATCH_SIZE: Math.max(1, Number(process.env.SUMMARY_BATCH_SIZE) || 8),
  HISTORY_FILE: path.join(__dirname, '../memory/car-news-pushed.json'),
  BATCH_SIZE: 10,
  // 飞书 API 相关
  FEISHU_APP_ID: process.env.FEISHU_APP_ID,
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
  FEISHU_BITABLE_APP_TOKEN: process.env.FEISHU_BITABLE_APP_TOKEN,
  FEISHU_BITABLE_TABLE_ID: process.env.FEISHU_BITABLE_TABLE_ID,

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

function fallbackSummary(title, content) {
  return content ? `${content.slice(0, 180)}...` : title;
}

function normalizeTitle(title) {
  return String(title || '').replace(/\s+/g, '').toLowerCase();
}

function openRouterModels() {
  return [...new Set([CONFIG.OPENROUTER_MODEL, ...CONFIG.OPENROUTER_FALLBACK_MODELS, 'openrouter/free'])];
}

function parseJsonArray(content) {
  const text = String(content || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(text);
  } catch (e) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw e;
  }
}

function requestOpenRouterSummary(model, prompt, maxTokens) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: maxTokens
    });

    const req = https.request('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://github.com/sourit2001/Daily-autonews',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error(`OpenRouter 返回非 JSON (HTTP ${res.statusCode}, model=${model}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`OpenRouter 请求超时 (model=${model})`)));
    req.write(postData);
    req.end();
  });
}

async function generateSummaryBatch(entries, batchIndex) {
  const items = entries.map(({ news, content }, index) =>
    `[${index + 1}] 标题：${news.title}\n正文片段：${(content || '').slice(0, 1000)}`
  ).join('\n\n');
  const prompt = `你是严谨的汽车行业编辑。请逐条阅读以下新闻，为每条新闻撰写独立摘要，绝不能把其他新闻的车型、品牌、参数或结论串入本条。
要求：
1. 先准确概括该条的事件、主体、关键数据/时间/配置，再补充其市场或行业含义。
2. 有正文时只使用本条正文可以支持的事实，不编造参数；仅有标题时明确基于标题概括，不扩写未经提供的事实。
3. 每条控制在100-160字，信息充分但不空泛。
4. "id" 和 "title" 必须逐字复写输入中的对应值，用于核对关联关系。
5. 输入有${entries.length}条，输出必须也有${entries.length}条；不得合并、遗漏、过滤任何一条。
6. 只输出严格 JSON 数组，不要 Markdown 代码块，不要额外文字。
格式：[{"id":1,"title":"输入标题原文","summary":"对应摘要内容"}]

新闻列表：
${items}`;

  try {
    const maxTokens = Math.min(4000, Math.max(1200, entries.length * 400));
    for (const model of openRouterModels()) {
      try {
        const { statusCode, body } = await requestOpenRouterSummary(model, prompt, maxTokens);
        if (!body?.choices?.[0]) {
          const errorMessage = body?.error?.message || JSON.stringify(body).slice(0, 300);
          console.warn(`  ⚠️ OpenRouter 摘要模型不可用 (HTTP ${statusCode}, model=${model}): ${errorMessage}`);
          continue;
        }

        const summaries = parseJsonArray(body.choices[0].message.content);
        entries.forEach(({ news, content: sourceContent }, index) => {
          const match = Array.isArray(summaries)
            ? summaries.find(item => Number(item.id) === index + 1)
            : null;
          const titleMatches = normalizeTitle(match?.title) === normalizeTitle(news.title);
          news.summary = titleMatches && typeof match?.summary === 'string' && match.summary.trim()
            ? match.summary.trim()
            : fallbackSummary(news.title, sourceContent);
          if (!titleMatches) {
            console.warn(`  ⚠️ 摘要关联校验失败，改用原文片段: ${news.title.slice(0, 35)}...`);
          }
        });
        console.log(`  [AI摘要] 第${batchIndex}批成功: ${body.model || model} (${entries.length}条)`);
        return;
      } catch (e) {
        console.warn(`  ⚠️ OpenRouter 摘要模型失败 (model=${model}): ${e.message}`);
        continue;
      }
    }
    console.error(`  ⚠️ OpenRouter 全部摘要模型均失败，改用原文片段: ${openRouterModels().join(' -> ')}`);
  } catch (e) {
    console.log(`  ⚠️ 批量摘要生成失败: ${e.message}`);
  }

  entries.forEach(({ news, content }) => {
    news.summary = fallbackSummary(news.title, content);
  });
}

// 小批量生成可减少串条，同时仍显著低于逐条调用的请求数量。
async function generateSummaries(entries) {
  if (!CONFIG.OPENROUTER_API_KEY) {
    entries.forEach(({ news, content }) => {
      news.summary = fallbackSummary(news.title, content);
    });
    return;
  }

  const totalBatches = Math.ceil(entries.length / CONFIG.SUMMARY_BATCH_SIZE);
  console.log(`🤖 摘要分为 ${totalBatches} 批生成，每批最多 ${CONFIG.SUMMARY_BATCH_SIZE} 条`);
  for (let i = 0; i < entries.length; i += CONFIG.SUMMARY_BATCH_SIZE) {
    const batch = entries.slice(i, i + CONFIG.SUMMARY_BATCH_SIZE);
    await generateSummaryBatch(batch, (i / CONFIG.SUMMARY_BATCH_SIZE) + 1);
    if (i + CONFIG.SUMMARY_BATCH_SIZE < entries.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
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

// 获取飞书 tenant_access_token
async function getFeishuAccessToken() {
  const postData = JSON.stringify({
    app_id: CONFIG.FEISHU_APP_ID,
    app_secret: CONFIG.FEISHU_APP_SECRET
  });

  return new Promise((resolve, reject) => {
    const req = https.request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.code === 0) {
            resolve(result.tenant_access_token);
          } else {
            reject(new Error(`获取Token失败: ${result.msg}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// 同步到飞书多维表格
async function syncToBitable(newsList) {
  if (!CONFIG.FEISHU_APP_ID || !CONFIG.FEISHU_BITABLE_APP_TOKEN) {
    console.log('⚠️ 未配置多维表格参数，跳过同步');
    return;
  }

  console.log(`\n📊 正在同步 ${newsList.length} 条新闻到多维表格...`);
  try {
    const token = await getFeishuAccessToken();
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_BITABLE_APP_TOKEN}/tables/${CONFIG.FEISHU_BITABLE_TABLE_ID}/records/batch_create`;

    // 格式化数据，匹配 Bitable 的列名
    const records = newsList.map(news => ({
      fields: {
        '标题': news.title,
        '分类': news.category || '其他',
        '摘要': news.summary || '',
        '来源': news.source || '',
        '链接': {
          'link': news.url,
          'text': '点击查看原文'
        },
        '日期': Date.now() // 时间戳
      }
    }));

    // 分批写入（飞书 API 限制单次最多 100 条）
    for (let i = 0; i < records.length; i += 100) {
      const batch = records.slice(i, i + 100);
      const postData = JSON.stringify({ records: batch });

      await new Promise((resolve, reject) => {
        const req = https.request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Content-Length': Buffer.byteLength(postData)
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            const result = JSON.parse(data);
            if (result.code === 0) {
              console.log(`  ✅ 成功写入 ${batch.length} 条记录`);
              resolve();
            } else {
              console.error(`  ❌ 写入失败: ${result.msg}`);
              resolve(); // 失败也继续，不阻断主流程
            }
          });
        });
        req.on('error', (e) => {
          console.error(`  ❌ 请求错误: ${e.message}`);
          resolve();
        });
        req.write(postData);
        req.end();
      });
    }
  } catch (e) {
    console.error(`  ❌ 同步多维表格失败: ${e.message}`);
  }
}


// 主函数
async function main() {
  console.log('🚀 每日汽车新闻推送开始');
  console.log(`📅 时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`🤖 OpenRouter 模型链: ${openRouterModels().join(' -> ')}`);
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
    const entriesForSummary = [];
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

        entriesForSummary.push({ news, content });
      }
    }

    console.log(`\n🤖 正在批量生成 ${entriesForSummary.length} 条摘要...`);
    await generateSummaries(entriesForSummary);

    // 推送到飞书
    console.log('\n📤 正在推送到飞书...');
    const bjNow = getZonedDateTime();
    const dateStr = `${bjNow.getMonth() + 1}月${bjNow.getDate()}日 ${String(bjNow.getHours()).padStart(2, '0')}:${String(bjNow.getMinutes()).padStart(2, '0')}`;
    await sendToFeishu(categorized, dateStr);

    // 将所有新闻打平准备写入表格
    const newsToSync = [];
    for (const category of Object.keys(categorized)) {
      categorized[category].forEach(news => {
        news.category = category; // 补充分类信息
        newsToSync.push(news);
      });
    }
    if (newsToSync.length > 0) {
      await syncToBitable(newsToSync);
    }

    // 更新历史记录
    const allPushed = Object.values(categorized).flat();
    const nowTs = Date.now();

    // 初始化新格式字段
    if (!history.newsHistory) history.newsHistory = [];

    allPushed.forEach(n => {
      history.pushedUrls.push(n.url);
      history.newsHistory.push({
        url: n.url,
        title: n.title,
        source: n.source,
        pushedAt: nowTs
      });
    });

    // 只保留最近 7 天的详细历史，避免文件过大
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    history.newsHistory = history.newsHistory.filter(item => (nowTs - item.pushedAt) < sevenDaysMs);

    // 去重冗余的 URL 记录 (可选，保持兼容)
    history.pushedUrls = [...new Set(history.pushedUrls)].slice(-2000);

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
