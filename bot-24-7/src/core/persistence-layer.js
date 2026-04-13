import fs from 'fs';
import path from 'path';

// v17.46.4: Sequential Lock to prevent Race Conditions (Read-Modify-Write)
const locks = new Map();

/**
 * runAtomicUpdate(file, updateFn)
 * Ensures that read and write operations on the same file are sequential.
 * v17.49.4: Robustness fix. Returns current data on failure instead of undefined to prevent crashes.
 */
export const runAtomicUpdate = async (filePath, updateFn) => {
    if (!locks.has(filePath)) {
        locks.set(filePath, Promise.resolve());
    }

    const currentLock = locks.get(filePath);
    const nextOp = currentLock.then(async () => {
        const isArray = filePath.includes('positions') || filePath.includes('history');
        const defaultVal = isArray ? [] : {};

        try {
            const data = safeReadJson(filePath, defaultVal);
            const updatedData = await updateFn(data);
            
            if (updatedData !== undefined) {
                atomicWriteJson(filePath, updatedData);
                return updatedData;
            }
            return data;
        } catch (e) {
            console.error(`[Atomic] Update failed for ${path.basename(filePath)}:`, e.message);
            // Return current disk state to prevent TypeError: cannot read property 'X' of undefined
            return safeReadJson(filePath, defaultVal);
        }
    });

    // Always append to the chain to keep order and prevent deadlocks
    locks.set(filePath, nextOp.catch(() => {})); 
    return nextOp;
};

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

export const safeReadJson = (filePath, defaultVal = {}) => {
    try {
        if (!fs.existsSync(filePath)) return defaultVal;
        const content = fs.readFileSync(filePath, 'utf8');
        if (!content || content.trim() === '') return defaultVal;
        return JSON.parse(content);
    } catch (e) {
        console.error(`[Persistence] Error reading ${path.basename(filePath)}:`, e.message);
        return defaultVal;
    }
};
