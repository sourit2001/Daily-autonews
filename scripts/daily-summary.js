const https = require('https');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const CONFIG = {
    FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    // 分类关键词
    CATEGORIES: {
        '电气化': ['纯电', '插混', '混动', 'PHEV', 'HEV', 'EV', '增程', '新能源', '电动', '电池', '续航', '充电'],
        '智能化': ['智驾', '自动驾驶', '辅助驾驶', 'ADAS', 'NOA', '座舱', '芯片', 'AI', '大模型'],
        '国际化': ['出海', '出口', '海外', '全球', '国际', '漫游', '欧洲', '美国']
    }
};

// 获取特定时区的时间
function getZonedDateTime() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utc + (3600000 * 8));
}

function getDisplayDate() {
    const bjNow = getZonedDateTime();
    return `${bjNow.getFullYear()}年${bjNow.getMonth() + 1}月${bjNow.getDate()}日`;
}

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

// 解析日期
function parseDate(dateStr) {
    if (!dateStr) return null;
    const cleanStr = dateStr.trim();
    const formats = [
        { regex: /(\d{4})-(\d{1,2})-(\d{1,2})/, hasYear: true },
        { regex: /(\d{1,2})月(\d{1,2})日/, hasYear: false },
    ];

    for (const format of formats) {
        const match = cleanStr.match(format.regex);
        if (match) {
            let year, month, day;
            if (format.hasYear) {
                year = parseInt(match[1]);
                month = parseInt(match[2]) - 1;
                day = parseInt(match[3]);
            } else {
                year = new Date().getFullYear();
                month = parseInt(match[1]) - 1;
                day = parseInt(match[2]);
            }
            return new Date(year, month, day).getTime();
        }
    }
    return null;
}

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
            const title = titleSnippet.replace(/^【|】$/g, '');
            const fullUrl = href.startsWith('http') ? href : `https://www.d1ev.com${href}`;
            return { title, url: fullUrl, source: '第一电动' };
        }
    }
];

async function fetchFromSource(source) {
    console.log(`📰 正在抓取: ${source.name}...`);
    try {
        const html = await httpGet(source.url);
        const $ = cheerio.load(html);
        const newsList = [];
        $(source.selector).each((_, elem) => {
            try {
                const news = source.extract($, elem);
                if (news && !newsList.find(n => n.url === news.url)) newsList.push(news);
            } catch (e) { }
        });
        return newsList;
    } catch (e) {
        return [];
    }
}

// 提取准确的时间戳
async function getNewsTimestamp(url) {
    try {
        const html = await httpGet(url);
        const $ = cheerio.load(html);
        const timeStr = $('.time, .date, .publish-time').first().text().trim();
        return parseDate(timeStr);
    } catch (e) {
        return null;
    }
}

async function generateDailySummary(newsList) {
    if (!CONFIG.DEEPSEEK_API_KEY) return "今日行业动态汇总。";

    const titles = newsList.map((n, i) => `${i + 1}. 【${n.source}】${n.title}`).join('\n');
    const prompt = `你是一个拥有 20 年经验的汽车行业资深主编。
请基于以下今日（${getDisplayDate()}）的新闻列表，撰写一份极具洞察力的【每日要闻总结】。

### 创作要求：
1. **精选 5 条最具有行业影响力的要闻**（新车发布、重大技术突破、跨国并购、政策变动等）。
2. **拒绝平铺直叙**：每条解读都要指出其背后的行业本质、竞争逻辑或未来风险。
3. **金句点睛**：在解读中适当加入犀利的行业点评。
4. **今日观察**：在文末提供一段 150 字左右的全局盘点，分析今日汽车市场的整体态势。

### 输出格式：
### 🏆 今日头条
**1. [新闻标题]**
> 解读：[深度、犀利的分析，50-80字]

**2. [新闻标题]**
> 解读：[深度、犀利的分析，50-80字]
...

### 🔍 今日观察
[总结文字]

---
新闻源列表：
${titles}`;

    try {
        const response = await new Promise((resolve, reject) => {
            const postData = JSON.stringify({
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.7,
                max_tokens: 2000
            });

            const req = https.request('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${CONFIG.DEEPSEEK_API_KEY}`
                },
                timeout: 60000
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
            req.write(postData);
            req.end();
        });

        return response?.choices?.[0]?.message?.content || "今日头条内容正在生成中...";
    } catch (e) {
        console.error('AI 总结生成失败:', e);
        return "今日行业动态丰富，主要集中在电气化转型和海外市场拓展。";
    }
}

async function sendToFeishu(summary, dateStr) {
    const elements = [
        {
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: `**📅 ${dateStr} | 每日汽车要闻总结**\n\n> 💡 *精选最有价值的行业动态，提供首席分析师级别的深度解读。*`
            }
        },
        { tag: 'hr' },
        {
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: summary
            }
        },
        { tag: 'hr' },
        {
            tag: 'note',
            elements: [
                { tag: 'plain_text', content: `📊 驱动：DeepSeek-V3 | � 来源：多源聚合` }
            ]
        }
    ];

    const card = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `� 汽车要闻 · 每日精选 | ${dateStr}` },
            template: 'violet' // 紫色调，显得专业且高级
        },
        elements
    };

    const data = JSON.stringify({ msg_type: 'interactive', card });

    return new Promise((resolve, reject) => {
        const req = https.request(CONFIG.FEISHU_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        }, (res) => {
            res.on('data', () => { });
            res.on('end', () => resolve());
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function main() {
    console.log('🚀 每日要闻总结任务启动');
    try {
        const HISTORY_FILE = path.join(__dirname, '../memory/car-news-pushed.json');
        let candidateNews = [];

        // 1. 优先从历史追踪记录中读取最近 24 小时的新闻
        if (fs.existsSync(HISTORY_FILE)) {
            const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            if (history.newsHistory) {
                const now = Date.now();
                const oneDayMs = 24 * 60 * 60 * 1000;
                candidateNews = history.newsHistory.filter(item => (now - item.pushedAt) <= oneDayMs);
                console.log(`📊 从历史记录中提取到过去 24h 追踪的新闻: ${candidateNews.length} 条`);
            }
        }

        // 2. 如果历史记录为空，兜底方案：直接抓取最新新闻
        if (candidateNews.length === 0) {
            console.log('⚠️ 历史记录不足，正在实时抓取最新新闻作为补充...');
            for (const source of NEWS_SOURCES) {
                const news = await fetchFromSource(source);
                candidateNews.push(...news);
            }
            candidateNews = candidateNews.slice(0, 30);
        }

        if (candidateNews.length === 0) {
            console.log('❌ 未发现任何新闻，任务终止');
            return;
        }

        console.log(`📊 最终汇总新闻共 ${candidateNews.length} 条，正在生成深度总结...`);
        const summary = await generateDailySummary(candidateNews);

        const bjNow = getZonedDateTime();
        const dateStr = `${bjNow.getMonth() + 1}月${bjNow.getDate()}日`;

        await sendToFeishu(summary, dateStr);
        console.log('✅ 每日要闻总结已推送到飞书');
    } catch (e) {
        console.error('❌ 任务执行失败:', e.message);
    }
}

main();
