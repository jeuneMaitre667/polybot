import fs from 'fs';
import path from 'path';

// v17.46.4: Sequential Lock to prevent Race Conditions (Read-Modify-Write)
const locks = new Map();

/**
 * runAtomicUpdate(file, updateFn)
 * Ensures that read and write operations on the same file are sequential.
 * v17.47.1: Fixed default data type to support Arrays (Positions).
 */
export const runAtomicUpdate = async (filePath, updateFn) => {
    if (!locks.has(filePath)) {
        locks.set(filePath, Promise.resolve());
    }

    const currentLock = locks.get(filePath);
    const nextOp = currentLock.then(async () => {
        try {
            // Detect if target is likely an array or object based on filename or existing content
            const isArray = filePath.includes('positions') || filePath.includes('history');
            const data = safeReadJson(filePath, isArray ? [] : {});
            
            const updatedData = await updateFn(data);
            if (updatedData !== undefined) {
                atomicWriteJson(filePath, updatedData);
            }
            return updatedData;
        } catch (e) {
            console.error(`[Atomic] Update failed for ${path.basename(filePath)}:`, e.message);
            // v17.47.1: We must NOT throw here to keep the lock chain alive and usable
            return undefined;
        }
    });

    // v17.47.1: Always append to the chain even if previous failed
    locks.set(filePath, nextOp);
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
