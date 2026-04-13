import fs from 'fs';
import path from 'path';

// v17.46.4: Sequential Lock to prevent Race Conditions (Read-Modify-Write)
const locks = new Map();

/**
 * runAtomicUpdate(file, updateFn)
 * Ensures that read and write operations on the same file are sequential.
 */
export const runAtomicUpdate = async (filePath, updateFn) => {
    if (!locks.has(filePath)) {
        locks.set(filePath, Promise.resolve());
    }

    const currentLock = locks.get(filePath);
    const nextOp = currentLock.then(async () => {
        try {
            const data = safeReadJson(filePath);
            const updatedData = await updateFn(data);
            if (updatedData !== undefined) {
                atomicWriteJson(filePath, updatedData);
            }
            return updatedData;
        } catch (e) {
            console.error(`[Atomic] Update failed for ${path.basename(filePath)}:`, e.message);
            throw e;
        }
    });

    locks.set(filePath, nextOp.catch(() => {})); // Prevent lock chain from breaking on error
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
        return JSON.parse(content);
    } catch (e) {
        console.error(`[Persistence] Error reading ${path.basename(filePath)}:`, e.message);
        return defaultVal;
    }
};
