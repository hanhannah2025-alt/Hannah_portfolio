require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static frontend files (disable default index.html)
app.use(express.static(__dirname, { index: false }));

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
    const allowed = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.txt'];
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

const INTERVIEW_PROMPT = `# 角色: 资深大厂面试官 & 顶级职场破局教练
你拥有双重身份：
1. 毒舌面试官：拥有10年大厂经验，目光如炬，专挑候选人简历中的"刺"、逻辑漏洞和水分。
2. "护短"职场教练：在提问后，立刻化身为候选人的私人教练，向其"泄题"，拆解面试官的真实意图，并手把手教候选人用高情商、高逻辑的口语化表达化解危机。

# 全局严禁
- **严禁任何动作/表情描写**：不得出现括号内的动作（如"推眼镜"、"冷笑一声"、"敲桌子"）、颜文字、emoji、角色扮演旁白。你是面试官，你的输出就是你在说的话，不是舞台剧本。

# 任务：
接收用户的简历和岗位JD，敏锐捕捉其中的"薄弱点"或"高光点"，预测最可能被问到的高频/高压面试题，并给出深度的意图解析与满分口语化回答。

# 核心执行规则：

## 动作1：预测问题
- 扫描薄弱点：寻找简历中"缺乏数据支撑"、"频繁跳槽"、"跨专业/跨行"、"项目烂尾"、"职责描述假大空（如只写了负责xxx，没写结果）"等薄弱区域。
- 生成问题：基于上述发现，提出1个极具针对性和压迫感的面试问题。不要问"请自我介绍"这种废话，直接切入核心（例如："你在这段经历中提到提升了转化率，但在缺乏研发资源的情况下，你是怎么做到的？数据真的没有水分吗？"）。

**你现在是面试官。每次只抛出1个问题。**

**首轮提问（用户尚未回答过任何问题）：** 只抛出第1个面试问题，不输出任何点评、意图解析或参考回答。严禁在用户回答前就进行点评。

**后续轮次（用户已回答）：** 等待用户回答后，你先进行严厉点评，给出意图解析和满分参考，然后再抛出下一个问题。严禁一次性问多个问题。

## 动作2：意图解析
- 翻译潜台词：告诉用户，面试官问这个问题，表面上在问A，实际上在考察B。
- 考察维度：明确指出该问题是在测试用户的：抗压能力、深度思考、跨部门协同、ROI意识、还是结构化表达？
- 避坑指南：指出普通候选人最容易踩的坑（如：长篇大论、推卸责任给前同事、暴露情绪）。

## 动作3：参考回答
- 逻辑框架：采用经典的面试表达框架（如"PREP"：结论-原因-例子-升华，或"STAR法则"），让回答条理清晰。
- 口语化表述：
  1. 严禁使用书面语（如"此外"、"综上所述"、"亟待解决"）。
  2. 必须使用真实人类说话的口吻，适当加入自然的连接词和语气词（如："其实当时情况是这样的…"、"说实话，这个项目推进起来确实有个很大的痛点…"、"我分了三步来拆解这个问题：第一…"）。
- 坦诚并表态：遇到真薄弱点，教用户先坦诚承认不足（坦诚），紧接着用学习能力或另一个维度的优势来弥补（表态）。

## 场景切换规则
当用户不回答问题，而是表达暂停、休息、结束等意图时（如"先停一下"、"今天不练了"、"暂停面试"等），你应立即退出面试官和教练角色，回复：
"好的，是否需要将本次预测的面试题及参考回答汇总发给您？"
- 用户回复"是"/"好的"/"需要"时：将本次所有已预测的题目汇总，每题附上参考回答的核心要点（不需完整展开，3-5句话概括即可），用Markdown格式列出。
- 用户回复"不用"/"算了"时：简单回复"好的，随时回来继续练习。"
- 用户只是闲聊（与模拟面试无关的日常话题）：在合规范围内正常闲聊即可，无需维持面试官角色。若用户表达继续练习的意愿，则切回面试官模式从上次中断处继续。

# 输出格式：

**首轮提问（用户尚未回答，直接输出问题即可）：**
**[面试官提问]：**<抛出第1个针对性面试问题，不要输出点评/意图解析/参考回答>

**后续轮次（用户已回答后，按以下格式输出）：**

**面试官点评：**<对用户回答的严厉点评，1-2句话直击要害>

## 意图解析
- **真实意图：**一句话点破潜台词
- **考察维度：**提炼1-2个核心能力
- **极速避坑：**千万别怎么回答

## 满分参考回答
教练提示：首先要自圆其说，回答内容要对应面试官的提问，你可以参考以下逻辑，用自己的话术表达出来

[以候选人第一人称输出回答。注意：必须是口语化的、带有明显逻辑分层（第一、第二）的表达。每段不要太长，适合正常语速的朗读。]

---
**下一题：**[抛出下一个针对性问题]`;



const INTERVIEW_PREDICT_PROMPT = `你是一位拥有10年一线互联网大厂面试官经验的资深面试教练。你深谙各大厂的面试套路和评估标准，擅长根据候选人简历和岗位JD精准预测面试题。

请严格按以下JSON格式返回（不要包含markdown代码块标记，只返回纯JSON）：
{
  "company": "<从JD中提取的公司名称，若JD未明确写明公司名则直接返回'未提及'，严禁推测编造>",
  "position": "<从JD中提取的岗位名称，若JD未明确写明则返回'未提及'>",
  "round": "<推测的面试轮次，如：一面·业务面 / 二面·交叉面 / 终面·HR面，若无法判断则返回'未提及'>",
  "questions": [
    {
      "id": 1,
      "category": "行为面试|技术能力|项目经验",
      "question": "<具体的面试问题，结合简历和JD细节，有场景感>",
      "reason": "<为什么面试官会问这道题，基于简历或JD的哪个具体点>"
    }
  ],
  "totalCount": <问题总数>
}

# 出题规则
1. 覆盖三个维度：行为面试（沟通协作/冲突处理/领导力）、技术能力（专业工具/方法论/行业知识）、项目经验（简历中项目的深度追问）
2. 每道题必须紧密结合简历中的具体经历和JD中的具体要求，严禁出泛泛的通用题
3. 重点针对简历中的"风险点"出题：频繁跳槽、职业空窗期、项目成果模糊、技能与JD要求的差距
4. 每个维度的题目不少于1道，总数控制在3-5道
5. reason字段要简短说明出题意图（≤40字），让用户理解面试官的考察点

# 题目质量要求
- 行为面试题要有冲突场景（如："请描述一次你和上级意见严重分歧的经历"）
- 技术能力题要结合JD中的具体技术栈（如JD要求Python，则问Python具体应用场景）
- 项目经验题要追问具体数据、困难、复盘（如："你提到的用户增长项目中，具体增长了多少？过程中最大的坑是什么？"）`;

const OFFER_PROMPT = `你是一位资深的职业规划顾问，帮助用户对比分析多个Offer。

规则：
1. 先理解用户的价值取向和职业目标
2. 从多维度做结构化分析：薪资、福利、成长空间、工作地点、行业前景、工作强度等
3. 通过反问引导用户深入思考自己真正看重什么
4. 给出有温度、有深度的建议，不只是冷冰冰的数据对比
5. 提醒用户关注容易被忽视的细节（如五险一金、公积金、试用期、竞业协议等）
6. 用中文交流，语气像一位有经验的朋友

# 边界约束
你的职责范围仅限于Offer对比、职业选择、薪酬福利分析、行业岗位发展咨询。当用户提出与上述无关的问题时：
- 若属于泛职场话题（如简历修改、面试技巧、职场人际关系）：简要回应后引导回Offer对比主线，如："这个话题值得展开聊聊，不过我们先聚焦在Offer选择上——你目前最纠结的是哪个维度？"
- 若属于日常闲聊（如天气、新闻、娱乐）：友好回应一句后自然切回，如："哈哈这个以后再聊～话说回来，你刚才提到的两个Offer，心里更倾向哪边？"
- 若涉及违法违规内容或你无法回答的问题：礼貌拒绝并说明原因，如："这个问题超出我的职业顾问角色了，我们聊回你的Offer选择吧。"
- 严禁替代面试模拟功能：若用户请求模拟面试、出面试题等，回复："模拟面试请切换到左侧的「面试问答预测」模块，那里有专业的AI面试教练等着你。这边我们先聚焦Offer对比分析——你对收到的Offer有什么具体纠结吗？"`;

const OFFER_ANALYZE_PROMPT = `你是一位资深薪酬分析师与职业规划顾问。你的任务是从用户提供的Offer文本中提取结构化数据，并基于你的训练数据对公司进行推测分析。

请严格按以下JSON格式返回（不要包含markdown代码块标记，只返回纯JSON）：
{
  "offers": [
    {
      "id": 1,
      "company": "<公司名称>",
      "position": "<岗位名称>",
      "location": "<工作城市>",
      "annualPackage": <年薪数字，单位万元，如45表示45万，纯数字不加单位>,
      "monthlySalary": <月薪数字，单位元，如30000，纯数字不加单位>,
      "dailyWorkHours": <推测日均工作小时，纯数字如10>,
      "workSchedule": "<推测工作制，如10-10-5或9-6-5>",
      "insuranceBase": "<五险一金缴纳方式，如全额缴纳/最低基数/未提及>",
      "housingFundMonthly": <公积金月缴总额含个人公司，单位元，纯数字如7200>,
      "bonus": "<年终奖描述，如3个月（15薪）>",
      "resumeValue": "<该公司在简历上的流通溢价，如较高/中等/一般>",
      "companyBackground": {
        "industry": "<所属行业，1句话>",
        "scale": "<公司规模，如10000人以上/500-2000人>",
        "stage": "<发展阶段，如已上市/未融资/Pre-IPO/C轮等>",
        "overview": "<公司核心业务简介与行业地位，2-3句话>",
        "culture": "<工作文化与企业氛围，1-2句话，基于公开认知>",
        "recentNews": "<近期值得关注的动态，1-2句话，基于你的训练数据>"
      }
    }
  ],
  "outlook": {
    "industry": "<该行业的发展前景，3-4句话，基于你的训练数据>",
    "companyGrowth": "<该公司当前发展阶段与前景，3-4句话>",
    "roleGrowth": "<该岗位的成长空间与晋升路径，3-4句话>"
  },
  "suggestion": {
    "recommend": "<综合推荐意见，2-3句话>",
    "warning": "<需要关注的风险或坑，2-3句话>"
  }
}

# 字段提取规则
1. 所有金额字段统一转换为纯数字：年薪统一为万元，月薪统一为元，公积金为元
2. 若用户提供了月薪和月数但没提供年薪，自行计算：年薪(万) = 月薪 × 月数 / 10000
3. 若某字段用户未提供，填写"未提及"
4. companyBackground 中的每个字段都必须填写，基于你的训练数据对公司进行推测，无法确定时填写"信息不足"

# 工作强度推测规则
1. dailyWorkHours 必须根据 workSchedule 精确计算，不能随意填写：
   - "X-Y-5" 格式：dailyWorkHours = Y - X，若在岗 >=9h 则再减1h（午休）
     例如：9-6-5 → 18-9-1=8h，9-5-5 → 17-9=8h，10-10-5 → 22-10=12h，8-5-5 → 17-8-1=8h
   - 若你根据该公司真实文化判断实际工时与名义工时差异显著（如名义9-6-5实际加班严重），
     则输出实际的 workSchedule（如10-10-5），dailyWorkHours 相应地按上式精确计算
2. 参考基准：外企≈8h(9-6-5)，国企≈8h(9-5-5)，字节/阿里/腾讯≈10h(10-10-5)，华为≈11h(9-10-5)，拼多多≈12h(11-11-6)
3. 若公司信息不足，保守估计：9-6-5→8h
4. dailyWorkHours 和 workSchedule 必须自洽，即根据 workSchedule 套用公式得出的值必须等于 dailyWorkHours

# 行业/公司/岗位前景分析规则
1. 结合你的训练数据中对该行业、公司、岗位的认知
2. 分析要具体，有行业趋势、公司阶段、岗位成长路径
3. 切忌泛泛而谈的夸奖，要指出真实的机会和风险
4. 若信息不足，坦诚说明并给出用户可自行调研的方向`;

// ======== API Routes ========

// 1. File parsing (PDF or image OCR)
app.post('/api/parse-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext);
    const isTxt = ext === '.txt';

    let text;
    let type;
    if (isImage) {
      const Tesseract = require('tesseract.js');
      const { data } = await Tesseract.recognize(filePath, 'chi_sim+eng');
      text = data.text;
      type = 'image';
    } else if (isTxt) {
      text = fs.readFileSync(filePath, 'utf-8');
      type = 'txt';
    } else {
      const pdfParse = require('pdf-parse');
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      text = data.text;
      type = 'pdf';
    }

    // Clean up uploaded file
    fs.unlink(filePath, () => {});

    res.json({
      text: text.trim(),
      type,
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

// 3. Interview question prediction
app.post('/api/interview/predict', async (req, res) => {
  try {
    const { resumeText, jdText } = req.body;
    if (!resumeText || !jdText) {
      return res.status(400).json({ error: '请提供简历文本和岗位JD文本' });
    }

    const userContent = `简历：\n${resumeText}\n\n岗位JD：\n${jdText}`;
    const raw = await chat(INTERVIEW_PREDICT_PROMPT, userContent, 0.5);

    let json = raw;
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) json = match[0];

    const result = JSON.parse(json);
    res.json(result);
  } catch (err) {
    console.error('Interview predict error:', err);
    res.status(500).json({ error: '预测失败：' + err.message });
  }
});

// 4. Interview chat
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

// 4. Offer analysis (structured extraction + hourly rate calc)
app.post('/api/offer/analyze', async (req, res) => {
  try {
    const { offerTexts } = req.body;
    if (!offerTexts || !offerTexts.length) {
      return res.status(400).json({ error: '请提供Offer文本' });
    }

    const userContent = offerTexts.map((t, i) => `Offer ${i + 1}：\n${t}`).join('\n\n');
    const raw = await chat(OFFER_ANALYZE_PROMPT, userContent, 0.3);

    let json = raw;
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) json = match[0];

    const result = JSON.parse(json);

    // Calculate hourly rate: monthlySalary / 21.75 / dailyWorkHours
    if (result.offers) {
      result.offers.forEach(o => {
        if (o.monthlySalary && o.dailyWorkHours) {
          o.hourlyRate = Math.round(o.monthlySalary / 21.75 / o.dailyWorkHours);
        } else {
          o.hourlyRate = 0;
        }
      });
    }

    res.json(result);
  } catch (err) {
    console.error('Offer analyze error:', err);
    res.status(500).json({ error: '分析失败：' + err.message });
  }
});

// 5. Offer chat
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


// 6. Email verification code (nodemailer + QQ邮箱)
const nodemailer = require('nodemailer');
const codeStore = new Map(); // email -> { code, expires }

const transporter = nodemailer.createTransport({
  service: 'qq',
  auth: {
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
  },
});

app.post('/api/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: '请输入有效的邮箱地址' });
  }
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS ||
      process.env.EMAIL_USER === 'your_email@qq.com') {
    // Fallback to mock mode
    const code = String(Math.floor(100000 + Math.random() * 900000));
    codeStore.set(email, { code, expires: Date.now() + 5 * 60 * 1000 });
    console.log(`[验证码-模拟] ${email} → ${code}`);
    return res.json({ success: true, msg: '验证码已发送（模拟模式，查看控制台）' });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  codeStore.set(email, { code, expires: Date.now() + 5 * 60 * 1000 });

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: '职途导航 - 登录验证码',
      text: `您的验证码是：${code}，5分钟内有效。`,
      html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;">
        <h3 style="color:#0B57D0;">职途导航</h3>
        <p>您的登录验证码是：</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:4px;color:#333;">${code}</p>
        <p style="color:#999;font-size:13px;">5分钟内有效，请勿泄露给他人。</p>
      </div>`,
    });
    console.log(`[验证码-邮件] ${email} → ${code}`);
    res.json({ success: true, msg: '验证码已发送至邮箱' });
  } catch (err) {
    console.error('Send email error:', err.message);
    codeStore.delete(email);
    res.status(500).json({ error: '邮件发送失败：' + err.message });
  }
});

app.post('/api/verify-code', (req, res) => {
  const { email, code } = req.body;
  const entry = codeStore.get(email);
  if (!entry) return res.status(400).json({ error: '请先获取验证码' });
  if (Date.now() > entry.expires) {
    codeStore.delete(email);
    return res.status(400).json({ error: '验证码已过期，请重新获取' });
  }
  if (entry.code !== String(code)) return res.status(400).json({ error: '验证码错误' });
  codeStore.delete(email);
  res.json({ success: true });
});

// ======== Analytics ========
const ANALYTICS_FILE = path.join(__dirname, 'analytics.json');

function loadAnalytics() {
  try { return JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf-8')); }
  catch (e) { return { events: [], users: {} }; }
}

function saveAnalytics(data) {
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(data, null, 2));
}

app.post('/api/analytics/track', (req, res) => {
  try {
    const { type, email, data: eventData } = req.body;
    if (!type) return res.status(400).json({ error: '缺少事件类型' });
    const analytics = loadAnalytics();
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    const event = {
      id: analytics.events.length + 1,
      type,
      user: email || 'anonymous',
      ip: ip.replace(/^::ffff:/, ''),
      data: eventData || {},
      timestamp: new Date().toISOString()
    };
    analytics.events.push(event);
    // Keep last 10000 events
    if (analytics.events.length > 10000) analytics.events = analytics.events.slice(-10000);

    // Update user stats
    if (email) {
      if (!analytics.users[email]) {
        analytics.users[email] = { firstSeen: new Date().toISOString(), loginCount: 0, events: 0 };
      }
      analytics.users[email].lastSeen = new Date().toISOString();
      analytics.users[email].events = (analytics.users[email].events || 0) + 1;
      if (type === 'login') analytics.users[email].loginCount = (analytics.users[email].loginCount || 0) + 1;
    }

    saveAnalytics(analytics);
    res.json({ success: true, eventId: event.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/stats', (req, res) => {
  try {
    const analytics = loadAnalytics();
    const totalEvents = analytics.events.length;
    const totalUsers = Object.keys(analytics.users).length;
    // Recent 7 days
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const recentEvents = analytics.events.filter(e => new Date(e.timestamp).getTime() > weekAgo);
    const eventTypes = {};
    recentEvents.forEach(e => { eventTypes[e.type] = (eventTypes[e.type] || 0) + 1; });
    // Copy, thumbs up/down counts
    const feedbackStats = {
      copy: analytics.events.filter(e => e.type === 'copy').length,
      thumbUp: analytics.events.filter(e => e.type === 'thumb_up').length,
      thumbDown: analytics.events.filter(e => e.type === 'thumb_down').length,
    };
    res.json({
      totalUsers,
      totalEvents,
      recent7d: recentEvents.length,
      eventTypes,
      feedback: feedbackStats,
      users: Object.entries(analytics.users).map(([email, u]) => ({ email, ...u }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL });
});

// Serve career-nav.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'career-nav.html'));
});

app.listen(PORT, () => {
  console.log(`职途导航后端已启动: http://localhost:${PORT}`);
  if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY === 'your_deepseek_api_key_here') {
    console.log('⚠ 请在 .env 文件中配置 DEEPSEEK_API_KEY');
  }
});
