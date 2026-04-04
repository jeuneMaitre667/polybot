import fs from 'fs';
import path from 'path';

/**
 * atomicWriteJson(file, data)
 * v8.0.0 : Write to .tmp then rename to avoid corruption
 */
export const atomicWriteJson = (filePath, data) => {
    try {
        const tmpPath = `${filePath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
        fs.renameSync(tmpPath, filePath);
        return true;
    } catch (e) {
        console.error(`[Persistence] Error writing ${path.basename(filePath)}:`, e.message);
        return false;
    }
};

/**
 * safeReadJson(file, defaultVal)
 * v8.0.0 : Read with validation
 */
export const safeReadJson = (filePath, defaultVal = {}) => {
    try {
        if (!fs.existsSync(filePath)) return defaultVal;
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (e) {
        console.error(`[Persistence] Error reading ${path.basename(filePath)}:`, e.message);
        return defaultVal;
    }
};
