require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// DeepSeek API client (OpenAI-compatible)
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'sk-placeholder',
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
});

const MODEL = 'deepseek-chat';

// Multer setup for file uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// ======== Chat helper ========
async function chat(systemPrompt, userContent, temperature = 0.7) {
  const messages = [
    { role: 'system', content: systemPrompt },
  ];
  if (typeof userContent === 'string') {
    messages.push({ role: 'user', content: userContent });
  } else if (Array.isArray(userContent)) {
    messages.push(...userContent);
  }

  // Remove placeholder
  if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY === 'your_deepseek_api_key_here') {
    return '请在 .env 文件中配置 DEEPSEEK_API_KEY';
  }

  const response = await client.chat.completions.create({
    model: MODEL,
    messages,
    temperature,
    max_tokens: 4096,
  });
  return response.choices[0].message.content;
}

// ======== Prompt templates ========
const RESUME_ANALYZE_PROMPT = `你是一位顶级大厂资深猎头与简历诊断专家。请严格按以下JSON格式返回分析结果（不要包含markdown代码块标记，只返回纯JSON）：

{
  "score": <0-100的整数>,
  "conclusion": "<一句话总结简历优劣势，点明过筛概率>",
  "comparison": [
    {"element": "学历", "jdRequirement": "<JD要求的学历>", "yourProfile": "<你的学历>", "status": "full|partial|missing"},
    {"element": "专业", "jdRequirement": "<JD要求的专业/方向>", "yourProfile": "<你的专业>", "status": "full|partial|missing"},
    {"element": "经验要求", "jdRequirement": "<JD要求的工作年限/行业经验>", "yourProfile": "<你的经验>", "status": "full|partial|missing"},
    {"element": "岗位技能", "jdRequirement": "<JD要求的工具/语言/技术栈>", "yourProfile": "<你掌握的技能>", "status": "full|partial|missing"},
    {"element": "项目经历", "jdRequirement": "<JD期望的项目类型/复杂度>", "yourProfile": "<你的项目经历>", "status": "full|partial|missing"}
  ],
  "suggestions": {
    "missing": ["<导致HR筛掉的致命缺失，每条≤30字>"],
    "supplement": ["<需要立刻补充的量化数据，每条≤30字>"],
    "risks": ["<面试会被反复追问的风险点，每条≤30字>"]
  }
}

# 分析流程
1. 拆解JD中的显性硬指标和隐性软需求
2. 必须逐一比对以下5个显性维度（不可遗漏任何一项）：学历、专业、经验要求、岗位技能、项目经历
3. 此外补充2-3个隐性维度（如业务理解深度、跨团队协同、从0到1落地能力、抗压特质等），追加到comparison数组末尾
4. 每个维度输出jdRequirement（JD诉求）和yourProfile（简历呈现），形成清晰对比，状态标记为 full（完全匹配）/ partial（勉强及格）/ missing（缺失）
5. 综合打分，用一句话总结核心优劣势和过筛概率
6. 输出极简优化建议：致命缺失点、急需补充的量化数据、面试潜在风险点`;

const INTERVIEW_PROMPT = `你是一位专业的面试教练。根据用户提供的简历和岗位JD进行模拟面试。

规则：
1. 每次只问一个问题，等待用户回答后再继续
2. 对用户的每个回答给出简短评估（1-2句话，包含优点和改进建议）
3. 追问要由浅入深，逐步深入
4. 覆盖行为面试、技术能力、项目经验三个维度
5. 用中文交流，语气专业但友善
6. 在合适的时候（约3-4轮后）可以问用户是否想换一个话题方向`;

const OFFER_PROMPT = `你是一位资深的职业规划顾问，帮助用户对比分析多个Offer。

规则：
1. 先理解用户的价值取向和职业目标
2. 从多维度做结构化分析：薪资、福利、成长空间、工作地点、行业前景、工作强度等
3. 通过反问引导用户深入思考自己真正看重什么
4. 给出有温度、有深度的建议，不只是冷冰冰的数据对比
5. 提醒用户关注容易被忽视的细节（如五险一金、公积金、试用期、竞业协议等）
6. 用中文交流，语气像一位有经验的朋友`;

// ======== API Routes ========

// 1. File parsing (PDF or image OCR)
app.post('/api/parse-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext);

    let text;
    if (isImage) {
      const Tesseract = require('tesseract.js');
      const { data } = await Tesseract.recognize(filePath, 'chi_sim+eng');
      text = data.text;
    } else {
      const pdfParse = require('pdf-parse');
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      text = data.text;
    }

    // Clean up uploaded file
    fs.unlink(filePath, () => {});

    res.json({
      text: text.trim(),
      type: isImage ? 'image' : 'pdf',
      length: text.trim().length,
    });
  } catch (err) {
    console.error('File parse error:', err);
    res.status(500).json({ error: '文件解析失败：' + err.message });
  }
});

// 2. Resume analysis
app.post('/api/resume/analyze', async (req, res) => {
  try {
    const { resumeText, jdText } = req.body;
    if (!resumeText || !jdText) {
      return res.status(400).json({ error: '请提供简历文本和岗位JD文本' });
    }

    const userContent = `简历：\n${resumeText}\n\n岗位JD：\n${jdText}`;
    const raw = await chat(RESUME_ANALYZE_PROMPT, userContent, 0.3);

    // Parse JSON from response (handle possible markdown wrapping)
    let json = raw;
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) json = match[0];

    const result = JSON.parse(json);
    res.json(result);
  } catch (err) {
    console.error('Resume analyze error:', err);
    res.status(500).json({ error: '分析失败：' + err.message });
  }
});

// 2b. Resume optimization (standalone)
const RESUME_OPTIMIZE_PROMPT = `你是一位拥有10年一线互联网大厂招聘经验的资深HR及简历精修专家。你精通人岗匹配逻辑，擅长通过深度挖掘候选人经历，将其重塑为极具市场竞争力的"高转化率"简历。

请严格按以下JSON格式返回（不要包含markdown代码块标记，只返回纯JSON）：
{
  "report": {
    "removed": "<删除了哪些无关经历及原因，简短概括>",
    "keywords": ["<从JD提取并植入的核心关键词1>", "<关键词2>", "<关键词3>"],
    "highlight": {
      "before": "<原始简历中一段代表性经历的原描述>",
      "after": "<STAR法则优化后的描述，包含背景、目标、行动、结果>"
    }
  },
  "optimizedResume": "优化后的完整简历，Markdown格式，包含核心优势(3条高密度总结)、核心技能清单、工作经历(STAR法则+力量型动词)、项目经历、教育背景"
}

# 执行规则
## 1. 精准过滤
- 大胆删除与目标JD核心需求完全无关的边缘工作内容、陈旧技术栈、无价值流水账
- 只保留能体现目标岗位所需硬技能、软素质（项目管理/跨部门沟通）和业务理解的经历

## 2. 关键词植入
- 提取JD核心关键词（工具软件、开发语言、业务模型、数据指标、软技能），自然揉碎植入到"个人优势"、"技能清单"和"项目经历"中
- 严禁生搬硬套，必须结合上下文逻辑

## 3. 力量型动词升级
- 全面替换低势能动词："做过"、"负责"、"参与"、"跟进"、"协助"等
- 必须使用高势能动词：主导、构建、优化、重构、操盘、驱动、落地、赋能、破局、从0到1孵化

## 4. STAR法则深度扩写
将所有保留的项目经历按STAR框架重构：
- S：项目背景、业务挑战、团队规模或技术难点
- T：具体业务指标或核心KPI
- A：关键动作、技术/策略、克服的困难
- R：量化结果，使用具体数据指标

# 约束
- 严禁凭空捏造数据或项目经历、公司履历
- 若原始简历缺乏具体数据，使用【补充具体提升百分比/数据】作为占位符，强制用户自行填补
- 优化后的简历修改处用【】包裹标注`;

app.post('/api/resume/optimize', async (req, res) => {
  try {
    const { resumeText, jdText } = req.body;
    if (!resumeText || !jdText) {
      return res.status(400).json({ error: '请提供简历文本和岗位JD文本' });
    }

    const userContent = `原始简历：\n${resumeText}\n\n岗位JD：\n${jdText}`;
    const raw = await chat(RESUME_OPTIMIZE_PROMPT, userContent, 0.5);

    // Parse JSON from response
    let json = raw;
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) json = match[0];

    const result = JSON.parse(json);
    res.json(result);
  } catch (err) {
    console.error('Resume optimize error:', err);
    res.status(500).json({ error: '优化失败：' + err.message });
  }
});

// 3. Interview chat
app.post('/api/interview/chat', async (req, res) => {
  try {
    const { messages, resumeText, jdText } = req.body;
    if (!messages) return res.status(400).json({ error: '请提供对话历史' });

    const systemPrompt = resumeText
      ? `${INTERVIEW_PROMPT}\n\n用户的简历：\n${resumeText}\n\n目标岗位JD：\n${jdText}`
      : INTERVIEW_PROMPT;

    // Build full message array for API
    const fullMessages = messages.map(m => ({ role: m.role, content: m.content }));

    const reply = await chat(systemPrompt, fullMessages, 0.8);
    res.json({ reply });
  } catch (err) {
    console.error('Interview chat error:', err);
    res.status(500).json({ error: '对话失败：' + err.message });
  }
});

// 4. Offer chat
app.post('/api/offer/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages) return res.status(400).json({ error: '请提供对话历史' });

    const fullMessages = messages.map(m => ({ role: m.role, content: m.content }));
    const reply = await chat(OFFER_PROMPT, fullMessages, 0.8);
    res.json({ reply });
  } catch (err) {
    console.error('Offer chat error:', err);
    res.status(500).json({ error: '对话失败：' + err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL });
});

app.listen(PORT, () => {
  console.log(`职途导航后端已启动: http://localhost:${PORT}`);
  if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY === 'your_deepseek_api_key_here') {
    console.log('⚠ 请在 .env 文件中配置 DEEPSEEK_API_KEY');
  }
});
