export const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) {
            throw new Error(`Condition not met within ${timeoutMs} ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};
