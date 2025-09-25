// Plugin/MessagePreprocessor/RAGDiaryPlugin/index.js

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto'); // <--- 引入加密模块
const TIME_EXPRESSIONS = require('./timeExpressions.config.js');
const SemanticGroupManager = require('./SemanticGroupManager.js');

// 从 DailyNoteGet 插件借鉴的常量和路径逻辑
const projectBasePath = process.env.PROJECT_BASE_PATH;
const dailyNoteRootPath = projectBasePath ? path.join(projectBasePath, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote');

const GLOBAL_SIMILARITY_THRESHOLD = 0.6; // 全局默认余弦相似度阈值

//####################################################################################
//## TimeExpressionParser - 时间表达式解析器
//####################################################################################
class TimeExpressionParser {
    constructor(locale = 'zh-CN') {
        this.setLocale(locale);
    }

    setLocale(locale) {
        this.locale = locale;
        this.expressions = TIME_EXPRESSIONS[locale] || TIME_EXPRESSIONS['zh-CN'];
    }

    // 将日期设置为北京时间 (UTC+8) 的开始
    _getBeijingTime(date = new Date()) {
        // 获取本地时间与UTC的时差（分钟）
        const localOffset = date.getTimezoneOffset() * 60000;
        // 北京时间是UTC+8
        const beijingOffset = 8 * 60 * 60 * 1000;
        // 转换为北京时间
        const beijingTime = new Date(date.getTime() + localOffset + beijingOffset);
        return beijingTime;
    }

    // 获取一天的开始和结束
    _getDayBoundaries(date) {
        const start = new Date(date);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 1);
        end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
        return { start, end };
    }
    
    // 核心解析函数 - V2 (支持多表达式)
    parse(text) {
        console.log(`[TimeParser] Parsing text for all time expressions: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
        const now = this._getBeijingTime(new Date());
        let remainingText = text;
        const results = [];

        // 1. 检查硬编码表达式 (从长到短排序)
        const sortedHardcodedKeys = Object.keys(this.expressions.hardcoded).sort((a, b) => b.length - a.length);
        for (const expr of sortedHardcodedKeys) {
            if (remainingText.includes(expr)) {
                const config = this.expressions.hardcoded[expr];
                console.log(`[TimeParser] Matched hardcoded expression: "${expr}"`);
                let result = null;
                if (config.days !== undefined) {
                    const targetDate = new Date(now);
                    targetDate.setUTCDate(now.getUTCDate() - config.days);
                    result = this._getDayBoundaries(targetDate);
                } else if (config.type) {
                    result = this._getSpecialRange(now, config.type);
                }
                if (result) {
                    results.push(result);
                    remainingText = remainingText.replace(expr, ''); // 消费掉匹配的部分
                }
            }
        }

        // 2. 检查动态模式
        for (const pattern of this.expressions.patterns) {
            const globalRegex = new RegExp(pattern.regex.source, 'g');
            let match;
            while ((match = globalRegex.exec(remainingText)) !== null) {
                console.log(`[TimeParser] Matched pattern: "${pattern.regex}" with text "${match[0]}"`);
                const result = this._handleDynamicPattern(match, pattern.type, now);
                if (result) {
                    results.push(result);
                    // 简单替换，可能不完美但能处理多数情况
                    remainingText = remainingText.replace(match[0], '');
                }
            }
        }

        if (results.length > 0) {
            // --- V2.1: 去重 ---
            const uniqueRanges = new Map();
            results.forEach(r => {
                const key = `${r.start.toISOString()}|${r.end.toISOString()}`;
                if (!uniqueRanges.has(key)) {
                    uniqueRanges.set(key, r);
                }
            });
            const finalResults = Array.from(uniqueRanges.values());

            if (finalResults.length < results.length) {
                console.log(`[TimeParser] Deduplicated ranges from ${results.length} to ${finalResults.length}.`);
            }
            
            console.log(`[TimeParser] Found ${finalResults.length} unique time expressions.`);
            finalResults.forEach((r, i) => {
                console.log(`  [${i+1}] Range: ${r.start.toISOString()} to ${r.end.toISOString()}`);
            });
            return finalResults;
        } else {
            console.log(`[TimeParser] No time expression found in text`);
            return []; // 始终返回数组
        }
    }

    _getSpecialRange(now, type) {
        let start = new Date(now);
        let end = new Date(now);
        start.setUTCHours(0, 0, 0, 0); // 所有计算都从当天的开始算起

        switch (type) {
            case 'thisWeek':
                const dayOfWeek = now.getUTCDay(); // 0=Sunday, 1=Monday...
                const diff = now.getUTCDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // adjust when sunday
                start.setUTCDate(diff);
                end = new Date(start);
                end.setUTCDate(start.getUTCDate() + 7);
                end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
                break;
            case 'lastWeek':
                const lastWeekDay = now.getUTCDay();
                const lastWeekDiff = now.getUTCDate() - lastWeekDay - 6;
                start.setUTCDate(lastWeekDiff);
                end = new Date(start);
                end.setUTCDate(start.getUTCDate() + 7);
                end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
                break;
            case 'thisMonth':
                start.setUTCDate(1);
                end = new Date(start);
                end.setUTCMonth(end.getUTCMonth() + 1);
                end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
                break;
            case 'lastMonth':
                start.setUTCDate(1);
                start.setUTCMonth(start.getUTCMonth() - 1);
                end = new Date(start);
                end.setUTCMonth(end.getUTCMonth() + 1);
                end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
                break;
            case 'thisMonthStart': // 本月初（1-10号）
                start.setUTCDate(1);
                end = new Date(start);
                end.setUTCDate(10);
                end.setUTCHours(23, 59, 59, 999);
                break;
            case 'lastMonthStart': // 上月初（1-10号）
                start.setUTCMonth(start.getUTCMonth() - 1);
                start.setUTCDate(1);
                end = new Date(start);
                end.setUTCDate(10);
                end.setUTCHours(23, 59, 59, 999);
                break;
            case 'lastMonthMid': // 上月中（11-20号）
                start.setUTCMonth(start.getUTCMonth() - 1);
                start.setUTCDate(11);
                end = new Date(start);
                end.setUTCDate(20);
                end.setUTCHours(23, 59, 59, 999);
                break;
            case 'lastMonthEnd': // 上月末（21号到月底）
                start.setUTCMonth(start.getUTCMonth() - 1);
                start.setUTCDate(21);
                end = new Date(start.getUTCFullYear(), start.getUTCMonth() + 1, 0); // 月底
                end.setUTCHours(23, 59, 59, 999);
                break;
        }
        return { start, end };
    }

    _handleDynamicPattern(match, type, now) {
        const numStr = match[1];
        const num = this.chineseToNumber(numStr);

        switch(type) {
            case 'daysAgo':
                const targetDate = new Date(now);
                targetDate.setUTCDate(now.getUTCDate() - num);
                return this._getDayBoundaries(targetDate);
            
            case 'weeksAgo':
                const weekStart = new Date(now);
                weekStart.setUTCDate(now.getUTCDate() - (num * 7) - now.getUTCDay() + 1);
                weekStart.setUTCHours(0, 0, 0, 0);
                const weekEnd = new Date(weekStart);
                weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
                weekEnd.setUTCHours(23, 59, 59, 999);
                return { start: weekStart, end: weekEnd };
            
            case 'monthsAgo':
                const monthsAgoDate = new Date(now);
                monthsAgoDate.setUTCMonth(now.getUTCMonth() - num);
                monthsAgoDate.setUTCDate(1);
                monthsAgoDate.setUTCHours(0, 0, 0, 0);
                const monthEnd = new Date(monthsAgoDate.getUTCFullYear(), monthsAgoDate.getUTCMonth() + 1, 0);
                monthEnd.setUTCHours(23, 59, 59, 999);
                return { start: monthsAgoDate, end: monthEnd };
            
            case 'lastWeekday':
                const weekdayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
                const targetWeekday = weekdayMap[match[1]];
                if (targetWeekday === undefined) return null;

                const lastWeekDate = new Date(now);
                const currentDay = now.getUTCDay(); // 0 = Sunday
                
                // 计算上周对应星期几的日期
                let daysToSubtract;
                if (targetWeekday === 0) { // 周日
                    daysToSubtract = currentDay === 0 ? 7 : (currentDay + 7);
                } else {
                    daysToSubtract = currentDay >= targetWeekday
                        ? (currentDay - targetWeekday + 7)
                        : (currentDay + 7 - targetWeekday);
                }
                
                lastWeekDate.setUTCDate(now.getUTCDate() - daysToSubtract);
                return this._getDayBoundaries(lastWeekDate);
        }
        
        return null;
    }

    chineseToNumber(chinese) {
        const basicMap = {
            '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
            '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
            '十一': 11, '十二': 12, '十三': 13, '十四': 14, '十五': 15,
            '十六': 16, '十七': 17, '十八': 18, '十九': 19,
            '二十': 20, '三十': 30, '日': 7, '天': 7
        };
        
        // 先检查是否在基础映射中
        if (basicMap[chinese] !== undefined) {
            return basicMap[chinese];
        }
        
        // 处理"二十一"到"三十九"这样的复合数字
        if (chinese.includes('十')) {
            // "二十一" -> ["二", "一"]
            const parts = chinese.split('十');
            if (parts.length === 2) {
                let tens = 10; // 默认"十"
                if (parts[0] === '二') tens = 20;
                else if (parts[0] === '三') tens = 30;
                
                const ones = basicMap[parts[1]] || 0;
                return tens + ones;
            }
        }
        
        return parseInt(chinese) || 0;
    }
}


class RAGDiaryPlugin {
    constructor() {
        this.name = 'RAGDiaryPlugin';
        this.vectorDBManager = null;
        this.ragConfig = {};
        this.enhancedVectorCache = {}; // <--- 新增：用于存储增强向量的缓存
        this.timeParser = new TimeExpressionParser('zh-CN'); // 实例化时间解析器
        this.semanticGroups = new SemanticGroupManager(this); // 实例化语义组管理器
        this.loadConfig();
    }

    async loadConfig() {
        const configPath = path.join(__dirname, 'rag_tags.json');
        const cachePath = path.join(__dirname, 'vector_cache.json');

        try {
            const currentConfigHash = await this._getFileHash(configPath);
            if (!currentConfigHash) {
                console.log('[RAGDiaryPlugin] 未找到 rag_tags.json 文件，跳过缓存处理。');
                this.ragConfig = {};
                return;
            }

            let cache = null;
            try {
                const cacheData = await fs.readFile(cachePath, 'utf-8');
                cache = JSON.parse(cacheData);
            } catch (e) {
                console.log('[RAGDiaryPlugin] 缓存文件不存在或已损坏，将重新构建。');
            }

            if (cache && cache.sourceHash === currentConfigHash) {
                // --- 缓存命中 ---
                console.log('[RAGDiaryPlugin] 缓存有效，从磁盘加载向量...');
                this.ragConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
                this.enhancedVectorCache = cache.vectors;
                console.log(`[RAGDiaryPlugin] 成功从缓存加载 ${Object.keys(this.enhancedVectorCache).length} 个向量。`);
            } else {
                // --- 缓存失效或未命中 ---
                if (cache) {
                    console.log('[RAGDiaryPlugin] rag_tags.json 已更新，正在重建缓存...');
                } else {
                    console.log('[RAGDiaryPlugin] 未找到有效缓存，首次构建向量缓存...');
                }

                const configData = await fs.readFile(configPath, 'utf-8');
                this.ragConfig = JSON.parse(configData);
                
                // 调用 _buildAndSaveCache 来生成向量
                await this._buildAndSaveCache(currentConfigHash, cachePath);
            }

        } catch (error) {
            console.error('[RAGDiaryPlugin] 加载配置文件或处理缓存时发生严重错误:', error);
            this.ragConfig = {};
        }
    }

    async _buildAndSaveCache(configHash, cachePath) {
        console.log('[RAGDiaryPlugin] 正在为所有日记本请求 Embedding API...');
        this.enhancedVectorCache = {}; // 清空旧的内存缓存

        for (const dbName in this.ragConfig) {
            // ... (这里的逻辑和之前 _buildEnhancedVectorCache 内部的 for 循环完全一样)
            const diaryConfig = this.ragConfig[dbName];
            const tagsConfig = diaryConfig.tags;

            if (Array.isArray(tagsConfig) && tagsConfig.length > 0) {
                let weightedTags = [];
                tagsConfig.forEach(tagInfo => {
                    const parts = tagInfo.split(':');
                    const tagName = parts[0].trim();
                    let weight = 1.0;
                    if (parts.length > 1) {
                        const parsedWeight = parseFloat(parts[1]);
                        if (!isNaN(parsedWeight)) weight = parsedWeight;
                    }
                    if (tagName) {
                        const repetitions = Math.max(1, Math.round(weight));
                        for (let i = 0; i < repetitions; i++) weightedTags.push(tagName);
                    }
                });
                
                const enhancedText = `${dbName} 的相关主题：${weightedTags.join(', ')}`;
                const enhancedVector = await this.getSingleEmbedding(enhancedText);

                if (enhancedVector) {
                    this.enhancedVectorCache[dbName] = enhancedVector;
                    console.log(`[RAGDiaryPlugin] -> 已为 "${dbName}" 成功获取向量。`);
                } else {
                    console.error(`[RAGDiaryPlugin] -> 为 "${dbName}" 获取向量失败。`);
                }
            }
        }
        
        // 构建新的缓存对象并保存到磁盘
        const newCache = {
            sourceHash: configHash,
            createdAt: new Date().toISOString(),
            vectors: this.enhancedVectorCache,
        };

        try {
            await fs.writeFile(cachePath, JSON.stringify(newCache, null, 2), 'utf-8');
            console.log(`[RAGDiaryPlugin] 向量缓存已成功写入到 ${cachePath}`);
        } catch (writeError) {
            console.error('[RAGDiaryPlugin] 写入缓存文件失败:', writeError);
        }
    }

    async _getFileHash(filePath) {
        try {
            const fileContent = await fs.readFile(filePath, 'utf-8');
            return crypto.createHash('sha256').update(fileContent).digest('hex');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null; // 文件不存在则没有哈希
            }
            throw error; // 其他错误则抛出
        }
    }

    setDependencies(dependencies) {
        if (dependencies.vectorDBManager) {
            this.vectorDBManager = dependencies.vectorDBManager;
            console.log('[RAGDiaryPlugin] VectorDBManager 依赖已注入。');
        }
    }
    
    cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) {
            return 0;
        }
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) {
            return 0;
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    _getWeightedAverageVector(vectors, weights) {
        const [vecA, vecB] = vectors;
        const [weightA, weightB] = weights;

        if (!vecA && !vecB) return null;
        // If one vector is missing, return the other one, effectively not averaging.
        if (vecA && !vecB) return vecA;
        if (!vecA && vecB) return vecB;

        if (vecA.length !== vecB.length) {
            console.error('[RAGDiaryPlugin] Vector dimensions do not match for weighted average.');
            return null;
        }

        const dimension = vecA.length;
        const result = new Array(dimension);

        for (let i = 0; i < dimension; i++) {
            result[i] = (vecA[i] * weightA) + (vecB[i] * weightB);
        }
        
        return result;
    }

    async getDiaryContent(characterName) {
        const characterDirPath = path.join(dailyNoteRootPath, characterName);
        let characterDiaryContent = `[${characterName}日记本内容为空]`;
        try {
            const files = await fs.readdir(characterDirPath);
            const relevantFiles = files.filter(file => {
                const lowerCaseFile = file.toLowerCase();
                return lowerCaseFile.endsWith('.txt') || lowerCaseFile.endsWith('.md');
            }).sort();

            if (relevantFiles.length > 0) {
                const fileContents = await Promise.all(
                    relevantFiles.map(async (file) => {
                        const filePath = path.join(characterDirPath, file);
                        try {
                            return await fs.readFile(filePath, 'utf-8');
                        } catch (readErr) {
                            return `[Error reading file: ${file}]`;
                        }
                    })
                );
                characterDiaryContent = fileContents.join('\n\n---\n\n');
            }
        } catch (charDirError) {
            if (charDirError.code !== 'ENOENT') {
                 console.error(`[RAGDiaryPlugin] Error reading character directory ${characterDirPath}:`, charDirError.message);
            }
            characterDiaryContent = `[无法读取“${characterName}”的日记本，可能不存在]`;
        }
        return characterDiaryContent;
    }

    _calculateDynamicK(userText, aiText = null) {
        // 1. 根据用户输入的长度计算 k_user
        const userLen = userText ? userText.length : 0;
        let k_user = 3;
        if (userLen > 100) {
            k_user = 7;
        } else if (userLen > 30) {
            k_user = 5;
        }

        // 如果没有 aiText (通常是首轮对话)，直接返回 k_user
        if (!aiText) {
            console.log(`[RAGDiaryPlugin] User-only turn. User query length (${userLen}), setting k=${k_user}.`);
            return k_user;
        }

        // 2. 根据 AI 回复的不重复【词元】数计算 k_ai，以更准确地衡量信息密度
        //    这个正则表达式会匹配连续的英文单词/数字，或单个汉字/符号，能同时兼容中英文。
        const tokens = aiText.match(/[a-zA-Z0-9]+|[^\s\x00-\xff]/g) || [];
        const uniqueTokens = new Set(tokens).size;
        
        let k_ai = 3;
        if (uniqueTokens > 100) {      // 阈值: 高信息密度 (>100个不同词元)
            k_ai = 7;
        } else if (uniqueTokens > 40) { // 阈值: 中等信息密度 (>40个不同词元)
            k_ai = 5;
        }

        // 3. 计算平均 k 值，并四舍五入
        const finalK = Math.round((k_user + k_ai) / 2);
        
        console.log(`[RAGDiaryPlugin] User len (${userLen})->k_user=${k_user}. AI unique tokens (${uniqueTokens})->k_ai=${k_ai}. Final averaged k=${finalK}.`);
        return finalK;
    }

    // processMessages 是 messagePreprocessor 的标准接口
    async processMessages(messages, pluginConfig) {
        // V2.4 修复: 精准定位包含占位符的system消息，避免在多system消息时污染其他消息
        const targetSystemMessageIndex = messages.findIndex(m =>
            m.role === 'system' &&
            typeof m.content === 'string' &&
            /\[\[.*日记本.*\]\]|<<.*日记本.*>>|《《.*日记本.*》》/.test(m.content)
        );

        // 如果没有找到任何包含RAG占位符的system消息，则直接返回，不做任何处理
        if (targetSystemMessageIndex === -1) {
            return messages;
        }

        const systemMessage = messages[targetSystemMessageIndex];

        // 更新正则表达式以捕获 ::Time 标记
        const groupAwareRegex = /\[\[(.*?)日记本(.*?)\]\]/g; // V2.1: More flexible regex
        const ragDeclarations = [...systemMessage.content.matchAll(groupAwareRegex)];
        const fullTextDeclarations = [...systemMessage.content.matchAll(/<<(.*?)日记本>>/g)];
        const hybridDeclarations = [...systemMessage.content.matchAll(/《《(.*?)日记本(.*?)》》/g)]; // V2.1: More flexible regex
        
        // --- [最终修复] 统一准备 userContent 和 aiContent ---
        const lastUserMessageIndex = messages.findLastIndex(m => m.role === 'user');
        let userContent = '';
        let aiContent = null;

        if (lastUserMessageIndex > -1) {
            const lastUserMessage = messages[lastUserMessageIndex];
            // 健壮地提取 userContent, 兼容 string 和 array 格式
            userContent = typeof lastUserMessage.content === 'string'
                ? lastUserMessage.content
                : (Array.isArray(lastUserMessage.content) ? lastUserMessage.content.find(p => p.type === 'text')?.text : '') || '';

            // 向前搜索并正确解析最近的 'assistant' 消息
            for (let i = lastUserMessageIndex - 1; i >= 0; i--) {
                const msg = messages[i];
                if (msg.role === 'assistant') {
                    if (typeof msg.content === 'string') {
                        aiContent = msg.content;
                    } else if (Array.isArray(msg.content)) {
                        aiContent = msg.content.find(p => p.type === 'text')?.text || null;
                    }
                    break; // 找到最近的一条就停止
                }
            }
        }

        // --- V2.5 优化: 独立向量化与加权平均 ---
        let userVector = null;
        let aiVector = null;

        if (userContent) {
            console.log(`[RAGDiaryPlugin] Vectorizing user query: "${userContent.substring(0, 100)}..."`);
            userVector = await this.getSingleEmbedding(userContent);
        }

        if (aiContent) {
            console.log(`[RAGDiaryPlugin] Vectorizing AI context: "${aiContent.substring(0, 100)}..."`);
            aiVector = await this.getSingleEmbedding(aiContent);
        }

        let queryVector = null;
        if (aiVector && userVector) {
            const userWeight = 0.7;
            const aiWeight = 0.3;
            console.log(`[RAGDiaryPlugin] Combining user and AI vectors with weights (User: ${userWeight}, AI: ${aiWeight}).`);
            queryVector = this._getWeightedAverageVector([userVector, aiVector], [userWeight, aiWeight]);
        } else if (userVector) {
            console.log('[RAGDiaryPlugin] Using user vector only for query.');
            queryVector = userVector;
        } else if (aiVector) {
            console.log('[RAGDiaryPlugin] Using AI vector only for query (no user message found).');
            queryVector = aiVector;
        }

        if (!queryVector) {
            console.error('[RAGDiaryPlugin] 查询向量化失败或未能构建有效向量，跳过RAG处理。');
            let contentWithoutPlaceholders = systemMessage.content;
            ragDeclarations.forEach(match => { contentWithoutPlaceholders = contentWithoutPlaceholders.replace(match[0], ''); });
            fullTextDeclarations.forEach(match => { contentWithoutPlaceholders = contentWithoutPlaceholders.replace(match[0], ''); });
            hybridDeclarations.forEach(match => { contentWithoutPlaceholders = contentWithoutPlaceholders.replace(match[0], ''); });
            messages.find(m => m.role === 'system').content = contentWithoutPlaceholders;
            return messages;
        }

        let processedSystemContent = systemMessage.content;

        // --- 处理 [[...]] RAG 片段检索 ---
        const dynamicK = this._calculateDynamicK(userContent, aiContent);

        // V2.3 修复 & 优化: 在循环外仅解析一次时间表达式
        const timeRanges = this.timeParser.parse(userContent);
        if (timeRanges.length > 0) {
            console.log(`[RAGDiaryPlugin] 识别到 ${timeRanges.length} 个时间范围，将为所有带::Time标记的日记本启用时间感知模式。`);
        }

        for (const match of ragDeclarations) {
            const placeholder = match[0];
            const dbName = match[1];
            const modifiers = match[2] || ''; // e.g., ":1.5::Time::Group"
            
            // --- 解析修饰符 ---
            const kMultiplierMatch = modifiers.match(/:(\d+\.?\d*)/);
            const kMultiplier = kMultiplierMatch ? parseFloat(kMultiplierMatch[1]) : 1.0;
            const useTime = modifiers.includes('::Time');
            const useGroup = modifiers.includes('::Group');

            const displayName = dbName + '日记本';
            const finalK = Math.max(1, Math.round(dynamicK * kMultiplier));
            let retrievedContent = '';
            let finalQueryVector = queryVector;
            let activatedGroups = null; // 用于存储激活的语义组信息

            console.log(`[RAGDiaryPlugin] Processing "${displayName}" with modifiers: "${modifiers}" -> kMultiplier: ${kMultiplier}, useTime: ${useTime}, useGroup: ${useGroup}`);

            // --- 步骤1: (可选) 语义组增强 ---
            if (useGroup) {
                console.log(`[RAGDiaryPlugin] 模式: 语义组增强 for ${displayName}`);
                activatedGroups = this.semanticGroups.detectAndActivateGroups(userContent);
                
                if (activatedGroups.size > 0) {
                    const enhancedVector = await this.semanticGroups.getEnhancedVector(queryText, activatedGroups);
                    if (enhancedVector) {
                        finalQueryVector = enhancedVector;
                        console.log(`[RAGDiaryPlugin] 语义组向量增强成功。`);
                    } else {
                         console.log(`[RAGDiaryPlugin] 语义组向量增强失败，回退到原始查询向量。`);
                    }
                } else {
                    console.log(`[RAGDiaryPlugin] 未激活任何语义组，使用原始查询向量。`);
                }
            }

            // --- 步骤2: (可选) 时间感知检索 ---
            if (useTime) {
                console.log(`[RAGDiaryPlugin] 模式: 时间感知 for ${displayName}`);
                
                if (timeRanges && timeRanges.length > 0) {
                    const allEntries = new Map();
                    for (const timeRange of timeRanges) {
                        // 使用可能被增强过的 finalQueryVector
                        const resultsData = await this.processWithTimeFilter(dbName, finalQueryVector, timeRange, finalK);
                        resultsData.results.forEach(entry => {
                            const key = entry.text.trim();
                            if (!allEntries.has(key)) {
                                allEntries.set(key, entry);
                            }
                        });
                    }
                    const uniqueResults = Array.from(allEntries.values());
                    retrievedContent = this.formatCombinedTimeAwareResults(uniqueResults, timeRanges, dbName);
                } else {
                    console.log(`[RAGDiaryPlugin] 时间模式已指定但未识别到时间表达式，回退到普通RAG模式 (可能已应用语义组增强)`);
                    const searchResults = await this.vectorDBManager.search(dbName, finalQueryVector, finalK);
                    // 如果Group模式也激活了，使用Group的格式化函数
                    if (useGroup) {
                        retrievedContent = this.formatGroupRAGResults(searchResults, displayName, activatedGroups);
                    } else {
                        retrievedContent = this.formatStandardResults(searchResults, displayName);
                    }
                }
            }
            // --- 步骤3: 普通或仅语义组增强的检索 ---
            else {
                if (useGroup) {
                    // 仅 Group 模式
                    console.log(`[RAGDiaryPlugin] 正在为 "${displayName}" 执行纯语义组增强检索...`);
                    const searchResults = await this.vectorDBManager.search(dbName, finalQueryVector, finalK);
                    retrievedContent = this.formatGroupRAGResults(searchResults, displayName, activatedGroups);
                } else {
                    // --- 普通 RAG 逻辑 ---
                    console.log(`[RAGDiaryPlugin] 正在为 "${displayName}" 执行标准检索 (数据库键: ${dbName})...`);
                    if (kMultiplier !== 1.0) {
                        console.log(`[RAGDiaryPlugin] 应用K值乘数: ${kMultiplier}. (基础K: ${dynamicK} -> 最终K: ${finalK})`);
                    }
                    const searchResults = await this.vectorDBManager.search(dbName, finalQueryVector, finalK);
                    retrievedContent = this.formatStandardResults(searchResults, displayName);
                }
            }
            
            processedSystemContent = processedSystemContent.replace(placeholder, retrievedContent);
        }

        // --- 处理 <<...>> RAG 全文检索 (加权标签和独立阈值增强版) ---
        for (const match of fullTextDeclarations) {
            const placeholder = match[0];
            const dbName = match[1];
            const diaryConfig = this.ragConfig[dbName] || {};
            const localThreshold = diaryConfig.threshold || GLOBAL_SIMILARITY_THRESHOLD;

            console.log(`[RAGDiaryPlugin] 正在为 <<${dbName}日记本>> 进行相关性评估 (阈值: ${localThreshold})...`);

            // 1. 基础名称向量
            const dbNameVector = await this.getSingleEmbedding(dbName);
            if (!dbNameVector) {
                console.error(`[RAGDiaryPlugin] 日记本名称 "${dbName}" 向量化失败，跳过。`);
                processedSystemContent = processedSystemContent.replace(placeholder, '');
                continue;
            }
            const baseSimilarity = this.cosineSimilarity(queryVector, dbNameVector);
            console.log(`[RAGDiaryPlugin] 基础名称 "${dbName}" 的相关度: ${baseSimilarity.toFixed(4)}`);

            // 2. 如果有标签，则计算加权增强向量的相似度
            let enhancedSimilarity = 0;
            // const tagsConfig = diaryConfig.tags; // 不再需要这行
            
            // 从缓存中直接获取预计算的向量
            const enhancedVector = this.enhancedVectorCache[dbName];

            if (enhancedVector) {
                enhancedSimilarity = this.cosineSimilarity(queryVector, enhancedVector);
                console.log(`[RAGDiaryPlugin] (从缓存) 加权增强文本的相关度: ${enhancedSimilarity.toFixed(4)}`);
            }

            // 3. 取两种相似度中的最大值作为最终决策依据
            const finalSimilarity = Math.max(baseSimilarity, enhancedSimilarity);
            console.log(`[RAGDiaryPlugin] <<${dbName}日记本>> 的最终决策相关度: ${finalSimilarity.toFixed(4)}`);

            // 4. 使用局部或全局阈值进行决策
            if (finalSimilarity >= localThreshold) {
                console.log(`[RAGDiaryPlugin] 相关度高于阈值 ${localThreshold}，将注入 "${dbName}" 的完整日记内容。`);
                const diaryContent = await this.getDiaryContent(dbName);
                processedSystemContent = processedSystemContent.replace(placeholder, diaryContent);
            } else {
                console.log(`[RAGDiaryPlugin] 相关度低于阈值，将忽略 <<${dbName}日记本>>。`);
                processedSystemContent = processedSystemContent.replace(placeholder, '');
            }
        }

        // --- 处理《〈...〉》混合模式：先判断阈值，再进行片段检索 ---
        for (const match of hybridDeclarations) {
            const placeholder = match[0];      // 例如 《《小克日记本:1.5》》
            const dbName = match[1];           // 例如 "小克"
            const modifiers = match[2] || '';
            const kMultiplierMatch = modifiers.match(/:(\d+\.?\d*)/);
            const kMultiplier = kMultiplierMatch ? parseFloat(kMultiplierMatch[1]) : 1.0;

            const diaryConfig = this.ragConfig[dbName] || {};
            const localThreshold = diaryConfig.threshold || GLOBAL_SIMILARITY_THRESHOLD;

            console.log(`[RAGDiaryPlugin] 正在为《《${dbName}日记本》》进行相关性评估 (阈值: ${localThreshold})...`);

            // 1. 计算相似度 (逻辑与 <<>> 模式完全相同)
            const dbNameVector = await this.getSingleEmbedding(dbName);
            if (!dbNameVector) {
                console.error(`[RAGDiaryPlugin] 日记本名称 "${dbName}" 向量化失败，跳过。`);
                processedSystemContent = processedSystemContent.replace(placeholder, '');
                continue;
            }
            const baseSimilarity = this.cosineSimilarity(queryVector, dbNameVector);
            let enhancedSimilarity = 0;
            const enhancedVector = this.enhancedVectorCache[dbName];

            if (enhancedVector) {
                enhancedSimilarity = this.cosineSimilarity(queryVector, enhancedVector);
            }
            const finalSimilarity = Math.max(baseSimilarity, enhancedSimilarity);
            console.log(`[RAGDiaryPlugin] 《《${dbName}日记本》》 的最终决策相关度: ${finalSimilarity.toFixed(4)}`);

            // 2. 决策：如果高于阈值，则执行片段检索
            if (finalSimilarity >= localThreshold) {
                console.log(`[RAGDiaryPlugin] 相关度高于阈值 ${localThreshold}，将为 "${dbName}" 执行片段检索。`);
                
                // 执行与 [[]] 模式完全相同的检索逻辑
                const finalK = Math.max(1, Math.round(dynamicK * kMultiplier));
                if (kMultiplier !== 1.0) {
                    console.log(`[RAGDiaryPlugin] 应用K值乘数: ${kMultiplier}. (基础K: ${dynamicK} -> 最终K: ${finalK})`);
                }

                const searchResults = await this.vectorDBManager.search(dbName, queryVector, finalK);
                
                let retrievedContent = `\n[--- 从"${dbName}日记本"中检索到的相关记忆片段 ---]\n`;
                if (searchResults && searchResults.length > 0) {
                    retrievedContent += searchResults.map(r => `* ${r.text.trim()}`).join('\n');
                } else {
                    retrievedContent += "没有找到直接相关的记忆片段。";
                }
                retrievedContent += `\n[--- 记忆片段结束 ---]\n`;
                
                processedSystemContent = processedSystemContent.replace(placeholder, retrievedContent);

            } else {
                console.log(`[RAGDiaryPlugin] 相关度低于阈值，将忽略《《${dbName}日记本》》。`);
                processedSystemContent = processedSystemContent.replace(placeholder, '');
            }
        }

        // --- V2.4 修复: 创建消息数组的深拷贝，并直接使用之前找到的索引进行精准更新 ---
        const newMessages = JSON.parse(JSON.stringify(messages));
        newMessages[targetSystemMessageIndex].content = processedSystemContent;

        if (process.env.DebugMode === 'true') {
            console.log(`[RAGDiaryPlugin] 已精准更新索引为 ${targetSystemMessageIndex} 的 system 消息。`);
        }
 
        return newMessages;
    }
    
    //####################################################################################
    //## Time-Aware RAG Logic - 时间感知RAG逻辑
    //####################################################################################

    async processWithTimeFilter(dbName, queryVector, timeRange, k) {
        console.log(`[RAGDiaryPlugin] Processing time-aware search for "${dbName}"`);
        console.log(`[RAGDiaryPlugin] Time range: ${timeRange.start.toISOString()} to ${timeRange.end.toISOString()}`);
        
        // Step 1: 获取RAG检索结果
        const ragResults = await this.vectorDBManager.search(dbName, queryVector, k);
        console.log(`[RAGDiaryPlugin] RAG search returned ${ragResults.length} results`);
        
        // Step 2: 获取时间范围内的日记
        const timeResults = await this.getTimeRangeDiaries(dbName, timeRange);
        console.log(`[RAGDiaryPlugin] Time range search found ${timeResults.length} entries`);
        
        // Step 3: 智能融合结果
        return this.mergeResults(ragResults, timeResults);
    }

    async getTimeRangeDiaries(dbName, timeRange) {
        const characterDirPath = path.join(dailyNoteRootPath, dbName);
        let diariesInRange = [];

        // 确保时间范围有效
        if (!timeRange || !timeRange.start || !timeRange.end) {
            console.error('[RAGDiaryPlugin] Invalid time range provided');
            return diariesInRange;
        }

        try {
            const files = await fs.readdir(characterDirPath);
            const diaryFiles = files.filter(file => file.toLowerCase().endsWith('.txt'));

            for (const file of diaryFiles) {
                const filePath = path.join(characterDirPath, file);
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const firstLine = content.split('\n')[0];
                    // V2.6: 兼容 [YYYY-MM-DD] 和 YYYY.MM.DD 两种日记时间戳格式
                    const match = firstLine.match(/^\[?(\d{4}[-.]\d{2}[-.]\d{2})\]?/);
                    if (match) {
                        const dateStr = match[1];
                        // 将 YYYY.MM.DD 格式规范化为 YYYY-MM-DD
                        const normalizedDateStr = dateStr.replace(/\./g, '-');
                        
                        // 确保使用UTC时间比较，避免时区问题
                        const diaryDate = new Date(normalizedDateStr + 'T00:00:00.000Z');
                        
                        if (diaryDate >= timeRange.start && diaryDate <= timeRange.end) {
                            diariesInRange.push({
                                date: normalizedDateStr, // 使用规范化后的日期
                                text: content,
                                source: 'time'
                            });
                        }
                    }
                } catch (readErr) {
                    // ignore individual file read errors
                }
            }
        } catch (dirError) {
            if (dirError.code !== 'ENOENT') {
                 console.error(`[RAGDiaryPlugin] Error reading character directory for time filter ${characterDirPath}:`, dirError.message);
            }
        }
        return diariesInRange;
    }

    mergeResults(ragResults, timeResults) {
        const maxTotal = 30; // 总结果上限

        // 确保RAG结果优先被包含 (取前40%或至少几个)
        const guaranteedRAGCount = Math.min(ragResults.length, Math.max(5, Math.floor(maxTotal * 0.4)));
        const guaranteedRAG = ragResults.slice(0, guaranteedRAGCount);
        
        // 剩余配额给时间结果
        const remainingQuota = maxTotal - guaranteedRAG.length;
        
        // 时间结果去重 (排除内容完全相同的)
        const uniqueTimeResults = timeResults.filter(tr =>
            !guaranteedRAG.some(rr => rr.text.trim() === tr.text.trim())
        );
        
        // 按时间新旧排序，取最新的
        const selectedTimeResults = uniqueTimeResults
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, remainingQuota);
        
        // 组合并标记来源
        const finalResults = [
            ...guaranteedRAG.map(r => ({...r, source: 'rag'})),
            ...selectedTimeResults
        ];
        
        return {
            results: finalResults,
            stats: {
                ragCount: guaranteedRAG.length,
                timeCount: selectedTimeResults.length,
                totalCount: finalResults.length,
                timeRangeTotal: timeResults.length
            }
        };
    }

    formatStandardResults(searchResults, displayName) {
        let content = `\n[--- 从"${displayName}"中检索到的相关记忆片段 ---]\n`;
        if (searchResults && searchResults.length > 0) {
            content += searchResults.map(r => `* ${r.text.trim()}`).join('\n');
        } else {
            content += "没有找到直接相关的记忆片段。";
        }
        content += `\n[--- 记忆片段结束 ---]\n`;
        return content;
    }

    formatTimeAwareResults(resultsData, dbName, timeRange) {
        const { results, stats } = resultsData;
        const displayName = dbName + '日记本';

        const formatDate = (date) => {
            const d = new Date(date);
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        }
    
        let content = `\n[--- "${displayName}" 时间感知检索结果 ---]\n`;
        content += `[时间范围: ${formatDate(timeRange.start)} 至 ${formatDate(timeRange.end)}]\n`;
        content += `[统计: RAG相关 ${stats.ragCount}条 | 时间范围 ${stats.timeCount}条 | 共 ${stats.totalCount}条`;
    
        if (stats.timeRangeTotal > stats.timeCount) {
            content += ` | 该时间段共有${stats.timeRangeTotal}条，已精选最新】\n`;
        } else {
            content += `]\n`;
        }
        content += '\n';
    
        const ragEntries = results.filter(e => e.source === 'rag');
        const timeEntries = results.filter(e => e.source === 'time');
    
        if (ragEntries.length > 0) {
            content += '【语义相关记忆】\n';
            ragEntries.forEach(entry => {
                // 尝试从文本中提取日期
                const dateMatch = entry.text.match(/^\[(\d{4}-\d{2}-\d{2})\]/);
                const datePrefix = dateMatch ? `[${dateMatch[1]}] ` : '';
                content += `* ${datePrefix}${entry.text.replace(/^\[.*?\]\s*-\s*.*?\n?/, '').trim()}\n`;
            });
        }
    
        if (timeEntries.length > 0) {
            content += '\n【时间范围记忆】\n';
            timeEntries.forEach(entry => {
                content += `* [${entry.date}] ${entry.text.replace(/^\[.*?\]\s*-\s*.*?\n?/, '').trim()}\n`;
            });
        }
    
        content += `[--- 检索结束 ---]\n`;
        return content;
    }

    formatCombinedTimeAwareResults(results, timeRanges, dbName) {
        const displayName = dbName + '日记本';
        const formatDate = (date) => {
            const d = new Date(date);
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        }
    
        let content = `\n[--- "${displayName}" 多时间感知检索结果 ---]\n`;
        
        const formattedRanges = timeRanges.map(tr => `"${formatDate(tr.start)} ~ ${formatDate(tr.end)}"`).join(' 和 ');
        content += `[合并查询的时间范围: ${formattedRanges}]\n`;
    
        const ragEntries = results.filter(e => e.source === 'rag');
        const timeEntries = results.filter(e => e.source === 'time');
        
        content += `[统计: 共找到 ${results.length} 条不重复记忆 (语义相关 ${ragEntries.length}条, 时间范围 ${timeEntries.length}条)]\n\n`;
    
        if (ragEntries.length > 0) {
            content += '【语义相关记忆】\n';
            ragEntries.forEach(entry => {
                const dateMatch = entry.text.match(/^\[(\d{4}-\d{2}-\d{2})\]/);
                const datePrefix = dateMatch ? `[${dateMatch[1]}] ` : '';
                content += `* ${datePrefix}${entry.text.replace(/^\[.*?\]\s*-\s*.*?\n?/, '').trim()}\n`;
            });
        }
    
        if (timeEntries.length > 0) {
            content += '\n【时间范围记忆】\n';
            // 按日期从新到旧排序
            timeEntries.sort((a, b) => new Date(b.date) - new Date(a.date));
            timeEntries.forEach(entry => {
                content += `* [${entry.date}] ${entry.text.replace(/^\[.*?\]\s*-\s*.*?\n?/, '').trim()}\n`;
            });
        }
    
        content += `[--- 检索结束 ---]\n`;
        return content;
    }

    formatGroupRAGResults(searchResults, displayName, activatedGroups) {
        let content = `\n[--- "${displayName}" 语义组增强检索结果 ---]\n`;
        
        if (activatedGroups && activatedGroups.size > 0) {
            content += `[激活的语义组:]\n`;
            for (const [groupName, data] of activatedGroups) {
                content += `  • ${groupName} (${(data.strength * 100).toFixed(0)}%激活): 匹配到 "${data.matchedWords.join(', ')}"\n`;
            }
            content += '\n';
        } else {
            content += `[未激活特定语义组]\n\n`;
        }
        
        content += `[检索到 ${searchResults ? searchResults.length : 0} 条相关记忆]\n`;
        if (searchResults && searchResults.length > 0) {
            content += searchResults.map(r => `* ${r.text.trim()}`).join('\n');
        } else {
            content += "没有找到直接相关的记忆片段。";
        }
        content += `\n[--- 检索结束 ---]\n`;
        
        return content;
    }

    async getSingleEmbedding(text) {
        if (!text) {
            console.error('[RAGDiaryPlugin] getSingleEmbedding was called with no text.');
            return null;
        }

        const apiKey = process.env.API_Key;
        const apiUrl = process.env.API_URL;
        const embeddingModel = process.env.WhitelistEmbeddingModel;

        if (!apiKey || !apiUrl || !embeddingModel) {
            console.error('[RAGDiaryPlugin] Embedding API credentials or model is not configured in environment variables.');
            return null;
        }

        try {
            const response = await axios.post(`${apiUrl}/v1/embeddings`, {
                model: embeddingModel,
                input: [text]
            }, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            const vector = response.data?.data?.[0]?.embedding;
            if (!vector) {
                console.error('[RAGDiaryPlugin] Valid embedding vector was not found in the API response.');
                return null;
            }
            return vector;
        } catch (error) {
            if (error.response) {
                console.error(`[RAGDiaryPlugin] Embedding API call failed with status ${error.response.status}: ${JSON.stringify(error.response.data)}`);
            } else if (error.request) {
                console.error('[RAGDiaryPlugin] Embedding API call made but no response received:', error.request);
            } else {
                console.error('[RAGDiaryPlugin] An error occurred while setting up the embedding request:', error.message);
            }
            return null;
        }
    }
}

// 导出实例以供 Plugin.js 加载
module.exports = new RAGDiaryPlugin();