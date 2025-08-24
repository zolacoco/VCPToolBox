const path = require('path');
const fs = require('fs').promises;

// --- 原有常量 ---
const CACHE_FILE_PATH = path.join(__dirname, 'dailyhot_cache.md');
const INTERNAL_TIMEOUT_MS = 30000;

// --- 【新增】指向“V日报日记”的路径常量 ---
// 我们假定此插件位于 /Plugin/DailyHot/ 目录下，需要跳出两层到项目根目录
const DIARY_NOTE_PATH = path.join(__dirname, '..', '..', 'dailynote', 'V日报日记');


// --- 【新增】核心函数：将新闻写入日报日记文件夹 ---
/**
 * 将聚合后的热榜数据按类别写入到指定的日记文件夹中。
 * @param {object} groupedData - 按类别分组后的新闻数据。
 */
async function writeNewsToDailyNote(groupedData) {
    try {
        // 确保目标目录存在，如果不存在则创建
        await fs.mkdir(DIARY_NOTE_PATH, { recursive: true });

        // 获取当前日期，格式为 YYYY-MM-DD
        const today = new Date().toISOString().slice(0, 10);

        console.log(`[DailyHot] 开始将热榜写入 V日报日记 文件夹...`);

        // 为每个新闻源（类别）创建一个单独的 .txt 文件
        for (const category in groupedData) {
            // 清理文件名，将不适合做文件名的字符替换掉
            const safeFileName = category.replace(/[\s\/\\]+/g, '_') + '.txt';
            const datedFileName = `${today}_${safeFileName}`;
            const filePath = path.join(DIARY_NOTE_PATH, datedFileName);
            
            // 格式化文件内容
            let fileContent = `---
来源: ${category}
日期: ${today}
---

`;
            groupedData[category].forEach((item, index) => {
                fileContent += `${index + 1}. ${item.title}\n`;
                fileContent += `链接: ${item.url}\n\n`;
            });

            // 写入文件
            await fs.writeFile(filePath, fileContent.trim(), 'utf-8');
            console.log(`[DailyHot] 成功创建日报文件: ${datedFileName}`);
        }
    } catch (error) {
        // 即便这里失败，也不应该影响主流程的缓存生成
        console.error(`[DailyHot] 写入日报文件到 V日报日记 文件夹时发生错误: ${error.message}`);
    }
}


async function fetchSource(source) {
    let routeHandler;
    try {
        const routePath = path.join(__dirname, 'dist', 'routes', `${source}.js`);
        routeHandler = require(routePath);
    } catch (e) {
        console.error(`[DailyHot] 加载 '${source}' 模块失败: ${e.message}`);
        return { source, error: `模块加载失败: ${e.message}` };
    }

    if (typeof routeHandler.handleRoute !== 'function') {
        return { source, error: `模块未导出 'handleRoute' 函数` };
    }

    try {
        const resultData = await routeHandler.handleRoute(null, true);
        if (!resultData || !Array.isArray(resultData.data)) {
             return { source, error: `返回的数据格式不正确` };
        }
        const title = resultData.title || source.charAt(0).toUpperCase() + source.slice(1);
        const type = resultData.type || '热榜';
        const category = `${title} - ${type}`;
        return resultData.data.map(item => ({
            category: category,
            title: item.title,
            url: item.url
        }));
    } catch (e) {
        console.error(`[DailyHot] 处理 '${source}' 数据时发生错误: ${e.message}`);
        return { source, error: `处理数据时发生错误: ${e.message}` };
    }
}

async function fetchAndProcessData() {
    let allSources = [];
    try {
        const routesDir = path.join(__dirname, 'dist', 'routes');
        const files = await fs.readdir(routesDir);
        allSources = files.filter(file => file.endsWith('.js')).map(file => path.basename(file, '.js'));
    } catch (e) {
        console.error(`[DailyHot] 无法读取数据源目录: ${e.message}`);
        return { success: false, data: null, error: e };
    }

    if (allSources.length === 0) {
        console.error('[DailyHot] 在 dist/routes 目录中没有找到任何数据源。');
        return { success: false, data: null, error: new Error('No sources found') };
    }

    const allResults = [];
    const promises = allSources.map(source => fetchSource(source));
    const results = await Promise.allSettled(promises);

    results.forEach(result => {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
            allResults.push(...result.value);
        } else if (result.status === 'fulfilled' && result.value.error) {
            console.error(`[DailyHot] 获取源失败: ${result.value.source} - ${result.value.error}`);
        } else if (result.status === 'rejected') {
            console.error(`[DailyHot] Promise for a source was rejected:`, result.reason);
        }
    });

    if (allResults.length > 0) {
        let markdownOutput = "# 每日热榜综合\n\n";
        const groupedByCategory = allResults.reduce((acc, item) => {
            if (!acc[item.category]) acc[item.category] = [];
            acc[item.category].push(item);
            return acc;
        }, {});

        // --- 【集成点】在这里调用新增的函数 ---
        // 在处理主缓存文件之前，先将数据写入日报文件夹
        await writeNewsToDailyNote(groupedByCategory);
        // ------------------------------------

        for (const category in groupedByCategory) {
            markdownOutput += `## ${category}\n\n`;
            groupedByCategory[category].forEach((item, index) => {
                markdownOutput += `${index + 1}. [${item.title}](${item.url})\n`;
            });
            markdownOutput += `\n`;
        }
        
        try {
            await fs.writeFile(CACHE_FILE_PATH, markdownOutput, 'utf-8');
            console.log(`[DailyHot] 成功更新缓存文件: ${CACHE_FILE_PATH}`);
        } catch(e) {
            console.error(`[DailyHot] 写入缓存文件失败: ${e.message}`);
        }
        return { success: true, data: markdownOutput, error: null };
    } else {
        return { success: false, data: null, error: new Error('Failed to fetch data from any source') };
    }
}

async function readCacheOnError() {
    try {
        const cachedData = await fs.readFile(CACHE_FILE_PATH, 'utf-8');
        console.log(`[DailyHot] 成功从缓存文件 ${CACHE_FILE_PATH} 提供数据。`);
        return cachedData;
    } catch (e) {
        const errorMessage = '# 每日热榜\n\n获取热榜数据失败，且本地无可用缓存。';
        console.error(`[DailyHot] 读取缓存文件失败: ${e.message}`);
        return errorMessage;
    }
}

(async () => {
    const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Internal script timeout')), INTERNAL_TIMEOUT_MS)
    );

    let output;
    try {
        const result = await Promise.race([
            fetchAndProcessData(),
            timeoutPromise
        ]);

        if (result.success) {
            output = result.data;
        } else {
            console.error(`[DailyHot] Fetch and process failed: ${result.error.message}. Falling back to cache.`);
            output = await readCacheOnError();
        }
    } catch (e) {
        console.error(`[DailyHot] Operation timed out or failed critically: ${e.message}. Falling back to cache.`);
        output = await readCacheOnError();
    }
    
    process.stdout.write(output, () => {
        // Ensure all output is written before exiting.
        process.exit(0);
    });
})();
