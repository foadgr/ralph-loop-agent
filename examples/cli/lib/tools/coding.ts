/**
 * Tools for the coding agent
 */

import { tool, generateText } from 'ai';
import { z } from 'zod';
import * as path from 'path';
import { runInSandbox, readFromSandbox, writeToSandbox, getSandboxDomain } from '../sandbox.js';
import { log } from '../logger.js';
import { MAX_FILE_CHARS, MAX_FILE_LINES_PREVIEW } from '../constants.js';

// Constants for Playwright in the sandbox
const PLAYWRIGHT_CACHE = '/home/vercel-sandbox/.cache/ms-playwright';
const GLOBAL_NODE_MODULES = '/home/vercel-sandbox/.global/npm/lib/node_modules';
const PLAYWRIGHT_ENV = `NODE_PATH="${GLOBAL_NODE_MODULES}" PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_CACHE}"`;

// Helper functions for file operations (used by both single and batch tools)
async function readFileImpl(filePath: string, lineStart?: number, lineEnd?: number) {
  try {
    const content = await readFromSandbox(filePath);
    if (!content) {
      return { success: false, error: 'File not found' };
    }
    
    const lines = content.split('\n');
    const totalLines = lines.length;
    
    // If specific range requested, extract it
    if (lineStart !== undefined || lineEnd !== undefined) {
      const start = Math.max(1, lineStart ?? 1);
      const end = Math.min(totalLines, lineEnd ?? totalLines);
      const selectedLines = lines.slice(start - 1, end);
      const numberedContent = selectedLines
        .map((line, i) => `${String(start + i).padStart(6)}| ${line}`)
        .join('\n');
      log(`      Read: ${filePath} lines ${start}-${end} of ${totalLines}`, 'dim');
      return { 
        success: true, 
        content: numberedContent,
        totalLines,
        lineRange: { start, end },
      };
    }
    
    // Auto-truncate large files
    if (content.length > MAX_FILE_CHARS) {
      const maxLines = Math.min(MAX_FILE_LINES_PREVIEW, totalLines);
      const selectedLines = lines.slice(0, maxLines);
      const numberedContent = selectedLines
        .map((line, i) => `${String(i + 1).padStart(6)}| ${line}`)
        .join('\n');
      const warning = `\n\n... [TRUNCATED: File has ${totalLines} lines, showing 1-${maxLines}. Use lineStart/lineEnd to read specific sections] ...`;
      log(`  [!] Read: ${filePath} (TRUNCATED: ${totalLines} lines, showing 1-${maxLines})`, 'yellow');
      return { 
        success: true, 
        content: numberedContent + warning,
        totalLines,
        truncated: true,
        lineRange: { start: 1, end: maxLines },
      };
    }
    
    log(`      Read: ${filePath} (${content.length} chars)`, 'dim');
    return { success: true, content, totalLines };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function writeFileImpl(filePath: string, content: string) {
  try {
    // Create parent directory if needed
    const dir = path.dirname(filePath);
    if (dir && dir !== '.') {
      await runInSandbox(`mkdir -p "${dir}"`);
    }
    await writeToSandbox(filePath, content);
    log(`  [+] Wrote: ${filePath}`, 'green');
    return { success: true, filePath };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function editFileImpl(filePath: string, old_string: string, new_string: string) {
  try {
    const content = await readFromSandbox(filePath);
    if (!content) {
      return { success: false, error: 'File not found' };
    }
    
    // Check for exact match
    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0) {
      return { 
        success: false, 
        error: 'old_string not found in file. Make sure it matches exactly (including whitespace).',
      };
    }
    if (occurrences > 1) {
      return { 
        success: false, 
        error: `old_string found ${occurrences} times - must be unique. Add more surrounding context to make it unique.`,
      };
    }
    
    // Perform replacement
    const newContent = content.replace(old_string, new_string);
    await writeToSandbox(filePath, newContent);
    
    log(`  [~] Edited: ${filePath}`, 'green');
    return { 
      success: true, 
      filePath,
      replaced: old_string.length > 100 ? old_string.slice(0, 100) + '...' : old_string,
      with: new_string.length > 100 ? new_string.slice(0, 100) + '...' : new_string,
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function deleteFileImpl(filePath: string) {
  try {
    await runInSandbox(`rm -f "${filePath}"`);
    log(`  [x] Deleted: ${filePath}`, 'yellow');
    return { success: true, filePath };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export function createCodingAgentTools() {
  const sandboxDomain = getSandboxDomain();

  return {
    detectPackageManager: tool({
      description: 'Detect which package manager to use based on lock files. ALWAYS call this before running install commands. Returns the package manager name and the commands to use.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          // Check for lock files to determine package manager
          const checks = await Promise.all([
            runInSandbox('test -f pnpm-lock.yaml && echo "found"'),
            runInSandbox('test -f yarn.lock && echo "found"'),
            runInSandbox('test -f package-lock.json && echo "found"'),
            runInSandbox('test -f bun.lockb && echo "found"'),
            runInSandbox('test -f package.json && echo "found"'),
          ]);
          
          const [pnpm, yarn, npm, bun, hasPackageJson] = checks.map(r => r.stdout.includes('found'));
          
          let packageManager: string;
          let install: string;
          let run: string;
          let add: string;
          let addDev: string;
          
          if (pnpm) {
            packageManager = 'pnpm';
            install = 'pnpm install';
            run = 'pnpm run';
            add = 'pnpm add';
            addDev = 'pnpm add -D';
          } else if (yarn) {
            packageManager = 'yarn';
            install = 'yarn install';
            run = 'yarn';
            add = 'yarn add';
            addDev = 'yarn add -D';
          } else if (bun) {
            packageManager = 'bun';
            install = 'bun install';
            run = 'bun run';
            add = 'bun add';
            addDev = 'bun add -D';
          } else if (npm) {
            packageManager = 'npm';
            install = 'npm install';
            run = 'npm run';
            add = 'npm install';
            addDev = 'npm install -D';
          } else if (hasPackageJson) {
            // Default to pnpm for JS/TS projects without lock file
            packageManager = 'pnpm';
            install = 'pnpm install';
            run = 'pnpm run';
            add = 'pnpm add';
            addDev = 'pnpm add -D';
            log(`      No lock file found, defaulting to pnpm`, 'dim');
          } else {
            return { 
              success: true, 
              packageManager: null,
              message: 'No package.json found - this may not be a JS/TS project',
            };
          }
          
          log(`      Detected package manager: ${packageManager}`, 'dim');
          return { 
            success: true, 
            packageManager,
            commands: { install, run, add, addDev },
            example: `Use "${install}" to install deps, "${run} dev" to start dev server`,
          };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),

    listFiles: tool({
      description: 'List files in the sandbox matching a pattern',
      inputSchema: z.object({
        pattern: z.string().describe('Pattern like "**/*.js" or "src/"'),
      }),
      execute: async ({ pattern }) => {
        try {
          const result = await runInSandbox(`find . -type f -path "*${pattern}*" | grep -v node_modules | grep -v .git | head -100`);
          const files = result.stdout.split('\n').filter(f => f.trim()).map(f => f.replace(/^\.\//, ''));
          log(`      Found ${files.length} files matching "${pattern}"`, 'dim');
          return { success: true, files };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),

    readFile: tool({
      description: 'Read one or more files. For large files, use lineStart/lineEnd to read specific sections.',
      inputSchema: z.object({
        files: z.array(z.object({
          filePath: z.string().describe('Path to the file'),
          lineStart: z.number().optional().describe('Start line (1-indexed)'),
          lineEnd: z.number().optional().describe('End line (inclusive)'),
        })).describe('Array of files to read (can be just one)'),
      }),
      execute: async ({ files }) => {
        if (files.length === 1) {
          const { filePath, lineStart, lineEnd } = files[0];
          return readFileImpl(filePath, lineStart, lineEnd);
        }
        const results = await Promise.all(
          files.map(async ({ filePath, lineStart, lineEnd }) => {
            const result = await readFileImpl(filePath, lineStart, lineEnd);
            return { filePath, ...result };
          })
        );
        return { success: true, files: results };
      },
    }),

    writeFile: tool({
      description: 'Write one or more files (creates directories if needed). For small changes to existing files, prefer editFile.',
      inputSchema: z.object({
        files: z.array(z.object({
          filePath: z.string().describe('Path to the file'),
          content: z.string().describe('The content to write'),
        })).describe('Array of files to write (can be just one)'),
      }),
      execute: async ({ files }) => {
        if (files.length === 1) {
          return writeFileImpl(files[0].filePath, files[0].content);
        }
        const results = await Promise.all(
          files.map(async ({ filePath, content }) => {
            const result = await writeFileImpl(filePath, content);
            return { filePath, ...result };
          })
        );
        const succeeded = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        return { success: failed === 0, succeeded, failed, files: results };
      },
    }),

    editFile: tool({
      description: 'Make one or more surgical edits by replacing specific text. More token-efficient than writeFile for small changes. Each old_string must be unique in its file. Edits to the same file are applied sequentially.',
      inputSchema: z.object({
        edits: z.array(z.object({
          filePath: z.string().describe('Path to the file'),
          oldString: z.string().describe('Exact text to find and replace (must be unique in the file)'),
          newString: z.string().describe('Text to replace it with'),
        })).describe('Array of edits to make (can be just one)'),
      }),
      execute: async ({ edits }) => {
        if (edits.length === 1) {
          return editFileImpl(edits[0].filePath, edits[0].oldString, edits[0].newString);
        }
        
        // Group edits by file to apply them sequentially within each file
        const editsByFile = new Map<string, typeof edits>();
        for (const edit of edits) {
          const existing = editsByFile.get(edit.filePath) || [];
          existing.push(edit);
          editsByFile.set(edit.filePath, existing);
        }
        
        const results: Array<{ filePath: string; success: boolean; error?: string }> = [];
        
        for (const [filePath, fileEdits] of editsByFile) {
          // Read file once
          let content = await readFromSandbox(filePath);
          if (!content) {
            for (const edit of fileEdits) {
              results.push({ filePath, success: false, error: 'File not found' });
            }
            continue;
          }
          
          // Apply edits sequentially
          let allSuccess = true;
          for (const edit of fileEdits) {
            const occurrences = content.split(edit.oldString).length - 1;
            if (occurrences === 0) {
              results.push({ 
                filePath, 
                success: false, 
                error: 'oldString not found in file',
              });
              allSuccess = false;
            } else if (occurrences > 1) {
              results.push({ 
                filePath, 
                success: false, 
                error: `oldString found ${occurrences} times - must be unique`,
              });
              allSuccess = false;
            } else {
              content = content.replace(edit.oldString, edit.newString);
              results.push({ filePath, success: true });
            }
          }
          
          // Write file once if any edits succeeded
          if (allSuccess || results.some(r => r.filePath === filePath && r.success)) {
            await writeToSandbox(filePath, content);
            log(`  [~] Edited: ${filePath} (${fileEdits.length} changes)`, 'green');
          }
        }
        
        const succeeded = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        return { success: failed === 0, succeeded, failed, edits: results };
      },
    }),

    deleteFile: tool({
      description: 'Delete one or more files.',
      inputSchema: z.object({
        files: z.array(z.string()).describe('Array of file paths to delete (can be just one)'),
      }),
      execute: async ({ files }) => {
        if (files.length === 1) {
          return deleteFileImpl(files[0]);
        }
        const results = await Promise.all(
          files.map(async (filePath) => {
            const result = await deleteFileImpl(filePath);
            return { filePath, ...result };
          })
        );
        const succeeded = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        return { success: failed === 0, succeeded, failed, files: results };
      },
    }),

    runCommand: tool({
      description: 'Run a shell command in the sandbox',
      inputSchema: z.object({
        command: z.string().describe('The shell command to run'),
      }),
      execute: async ({ command }) => {
        try {
          log(`  [>] Running: ${command}`, 'blue');
          const result = await runInSandbox(command);
          const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : '');
          
          if (result.exitCode === 0) {
            log(`      Command completed`, 'dim');
          } else {
            log(`  [x] Command failed (exit ${result.exitCode})`, 'red');
          }
          
          return { 
            success: result.exitCode === 0, 
            output: output.slice(0, 8000),
            exitCode: result.exitCode,
          };
        } catch (error: any) {
          log(`  [x] Command failed`, 'red');
          return { success: false, error: error.message };
        }
      },
    }),

    startDevServer: tool({
      description: 'Start a development server in the background. Returns the URL where the app is accessible.',
      inputSchema: z.object({
        command: z.string().optional().describe('Custom start command (auto-detects if not provided)'),
      }),
      execute: async ({ command }) => {
        try {
          // Determine start command
          let startCmd = command;
          if (!startCmd) {
            // Auto-detect
            const pkgJson = await readFromSandbox('package.json');
            if (pkgJson) {
              const pkg = JSON.parse(pkgJson);
              if (pkg.scripts?.dev) startCmd = 'npm run dev';
              else if (pkg.scripts?.start) startCmd = 'npm run start';
            }
          }

          if (!startCmd) {
            return { success: false, error: 'Could not detect start command. Please provide one.' };
          }

          // Kill any existing server on port 3000
          await runInSandbox('fuser -k 3000/tcp 2>/dev/null || true');
          
          // Start in background
          const bgCmd = `nohup sh -c '${startCmd}' > /tmp/server.log 2>&1 &`;
          await runInSandbox(bgCmd);
          
          // Wait a moment for server to start
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          log(`  [+] Dev server starting at ${sandboxDomain}`, 'green');
          return { 
            success: true, 
            url: sandboxDomain,
            command: startCmd,
            logFile: '/tmp/server.log',
          };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),

    curl: tool({
      description: 'Make an HTTP request (useful for testing the dev server)',
      inputSchema: z.object({
        url: z.string().describe('URL to request (use localhost:3000 for the sandbox dev server)'),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional().describe('HTTP method'),
      }),
      execute: async ({ url, method }) => {
        try {
          const resolvedUrl = url.replace('localhost:3000', sandboxDomain || 'localhost:3000');
          const result = await runInSandbox(`curl -s -X ${method || 'GET'} "${resolvedUrl}"`);
          return { success: true, response: result.stdout.slice(0, 5000) };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),

    runPlaywrightTest: tool({
      description: 'Run a Playwright test script to interact with and verify the web app. Write the test file first, then run it. Tests should use the sandbox URL for navigation. IMPORTANT: First call detectPackageManager, then install dependencies and start the dev server BEFORE using this tool.',
      inputSchema: z.object({
        testFile: z.string().describe('Path to the Playwright test file (e.g., tests/e2e.spec.ts)'),
        headed: z.boolean().optional().describe('Run with visible browser (slower, good for debugging)'),
      }),
      execute: async ({ testFile, headed }) => {
        try {
          log(`  [>] Running Playwright test: ${testFile}`, 'blue');
          
          // Run the test with npx playwright
          const headedFlag = headed ? '--headed' : '';
          const result = await runInSandbox(
            `npx playwright test "${testFile}" ${headedFlag} --reporter=line 2>&1`
          );
          
          const output = result.stdout + result.stderr;
          
          if (result.exitCode === 0) {
            log(`      Playwright test passed`, 'green');
          } else {
            log(`  [x] Playwright test failed`, 'red');
          }
          
          return {
            success: result.exitCode === 0,
            output: output.slice(0, 8000),
            exitCode: result.exitCode,
            sandboxUrl: sandboxDomain,
          };
        } catch (error: any) {
          log(`  [x] Playwright test failed`, 'red');
          return { success: false, error: error.message };
        }
      },
    }),

    takeScreenshot: tool({
      description: 'Take a screenshot of the web app and get a visual description. The screenshot is analyzed by a vision model so you can "see" what the page looks like. IMPORTANT: First call detectPackageManager, then install dependencies and start the dev server BEFORE using this tool.',
      inputSchema: z.object({
        url: z.string().optional().describe('URL to screenshot (defaults to sandbox dev server)'),
        outputPath: z.string().optional().describe('Where to save the screenshot (defaults to /tmp/screenshot.png)'),
        fullPage: z.boolean().optional().describe('Capture full scrollable page'),
        analyze: z.boolean().optional().describe('Analyze the screenshot with vision model (default: true)'),
        question: z.string().optional().describe('Specific question to ask about the screenshot (e.g., "Is the header visible?")'),
      }),
      execute: async ({ url, outputPath, fullPage, analyze = true, question }) => {
        try {
          // sandboxDomain already includes https://
          const baseUrl = sandboxDomain?.startsWith('https://') ? sandboxDomain : `https://${sandboxDomain}`;
          const targetUrl = url?.replace('localhost:3000', baseUrl?.replace('https://', '') || 'localhost:3000') 
            || baseUrl;
          const output = outputPath || '/tmp/screenshot.png';
          const fullPageOpt = fullPage ? 'fullPage: true,' : '';
          
          log(`  [>] Taking screenshot of ${targetUrl}`, 'blue');
          
          // Create a Playwright script to take a screenshot
          const script = `const { chromium } = require('playwright');
(async () => {
  try {
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'networkidle', timeout: 30000 });
    await page.screenshot({ path: ${JSON.stringify(output)}, ${fullPageOpt} });
    console.log('Screenshot saved');
    await browser.close();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
`;
          
          await writeToSandbox('/tmp/screenshot.js', script);
          const result = await runInSandbox(`${PLAYWRIGHT_ENV} node /tmp/screenshot.js 2>&1`);
          
          if (result.exitCode !== 0) {
            log(`  [x] Screenshot failed`, 'red');
            return { success: false, error: result.stdout || result.stderr };
          }
          
          log(`      Screenshot saved to ${output}`, 'green');
          
          // Analyze the screenshot if requested
          if (analyze) {
            log(`      Analyzing screenshot...`, 'dim');
            
            // Read the screenshot as base64
            const imageResult = await runInSandbox(`base64 -w 0 ${output} 2>&1`);
            if (imageResult.exitCode !== 0 || !imageResult.stdout) {
              return { success: true, path: output, url: targetUrl, analysis: 'Could not read screenshot for analysis' };
            }
            
            const imageBase64 = imageResult.stdout.trim();
            
            // Analyze with vision model
            const prompt = question 
              ? `Look at this screenshot and answer: ${question}`
              : `Describe what you see in this screenshot of a web page. Focus on:
1. Layout and structure (header, content, footer)
2. Visual elements (colors, fonts, spacing)
3. Any obvious issues (broken layout, overlapping elements, missing content)
4. Overall appearance and user experience

Be concise but thorough.`;

            try {
              const analysisResult = await generateText({
                model: 'anthropic/claude-sonnet-4-20250514' as any,
                messages: [
                  {
                    role: 'user',
                    content: [
                      { type: 'text', text: prompt },
                      { type: 'image', image: `data:image/png;base64,${imageBase64}` },
                    ],
                  },
                ],
              });
              
              const analysis = analysisResult.text;
              log(`      Analysis complete`, 'green');
              // Show a preview of the analysis
              const analysisPreview = analysisResult.text.slice(0, 200) + (analysisResult.text.length > 200 ? '...' : '');
              log(`      Vision: ${analysisPreview}`, 'dim');
              
              return { 
                success: true, 
                path: output, 
                url: targetUrl,
                analysis,
              };
            } catch (analysisError: any) {
              log(`      Analysis failed: ${analysisError.message}`, 'yellow');
              return { 
                success: true, 
                path: output, 
                url: targetUrl,
                analysis: `Screenshot taken but analysis failed: ${analysisError.message}`,
              };
            }
          }
          
          return { success: true, path: output, url: targetUrl };
        } catch (error: any) {
          log(`  [x] Screenshot failed`, 'red');
          return { success: false, error: error.message };
        }
      },
    }),

    browserInteract: tool({
      description: 'Interact with the web app using Playwright. Navigate, click elements, fill forms, and get page state. Returns what the page looks like after the action. IMPORTANT: First call detectPackageManager, then install dependencies and start the dev server BEFORE using this tool.',
      inputSchema: z.object({
        action: z.enum(['navigate', 'click', 'fill', 'getContent', 'getAccessibility', 'waitFor']).describe('Action to perform'),
        url: z.string().optional().describe('URL to navigate to (for navigate action)'),
        selector: z.string().optional().describe('CSS selector for the element (for click, fill actions)'),
        text: z.string().optional().describe('Text to type (for fill action)'),
        waitForSelector: z.string().optional().describe('Selector to wait for (for waitFor action)'),
        screenshotAfter: z.boolean().optional().describe('Take and analyze a screenshot after the action (default: true)'),
      }),
      execute: async ({ action, url, selector, text, waitForSelector, screenshotAfter = true }) => {
        try {
          // sandboxDomain already includes https://
          const baseUrl = sandboxDomain?.startsWith('https://') ? sandboxDomain : `https://${sandboxDomain}`;
          const targetUrl = url?.replace('localhost:3000', baseUrl?.replace('https://', '') || 'localhost:3000') || baseUrl;
          
          log(`  [>] Browser: ${action}${selector ? ` on "${selector}"` : ''}${url ? ` to ${url}` : ''}`, 'blue');
          
          let actionCode = '';
          switch (action) {
            case 'navigate':
              actionCode = `await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'networkidle', timeout: 30000 });`;
              break;
            case 'click':
              if (!selector) return { success: false, error: 'selector is required for click action' };
              actionCode = `await page.click(${JSON.stringify(selector)});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});`;
              break;
            case 'fill':
              if (!selector) return { success: false, error: 'selector is required for fill action' };
              if (text === undefined) return { success: false, error: 'text is required for fill action' };
              actionCode = `await page.fill(${JSON.stringify(selector)}, ${JSON.stringify(text)});`;
              break;
            case 'getContent':
              actionCode = `const content = await page.content();
      const textContent = await page.evaluate(() => document.body.innerText);
      console.log('PAGE_CONTENT_START');
      console.log(textContent.slice(0, 5000));
      console.log('PAGE_CONTENT_END');`;
              break;
            case 'getAccessibility':
              actionCode = `const snapshot = await page.accessibility.snapshot();
      console.log('ACCESSIBILITY_START');
      console.log(JSON.stringify(snapshot, null, 2).slice(0, 8000));
      console.log('ACCESSIBILITY_END');`;
              break;
            case 'waitFor':
              if (!waitForSelector) return { success: false, error: 'waitForSelector is required for waitFor action' };
              actionCode = `await page.waitForSelector(${JSON.stringify(waitForSelector)}, { timeout: 10000 });`;
              break;
          }
          
          const screenshotCode = screenshotAfter ? `
      await page.screenshot({ path: '/tmp/browser-action.png' });
      console.log('SCREENSHOT_SAVED');` : '';
          
          const script = `const { chromium } = require('playwright');
(async () => {
  let browser;
  try {
    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(${JSON.stringify(baseUrl)}, { waitUntil: 'networkidle', timeout: 30000 });
    
    // Perform the action
    ${actionCode}
    ${screenshotCode}
    
    console.log('ACTION_SUCCESS');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
`;
          
          await writeToSandbox('/tmp/browser-interact.js', script);
          const result = await runInSandbox(`${PLAYWRIGHT_ENV} node /tmp/browser-interact.js 2>&1`);
          
          if (result.exitCode !== 0) {
            const errorOutput = (result.stdout || result.stderr || 'Unknown error').slice(0, 300);
            log(`  [x] Browser action failed: ${errorOutput}`, 'red');
            return { success: false, error: result.stdout || result.stderr };
          }
          
          log(`      Action completed`, 'green');
          
          // Extract content if getContent action
          let pageContent: string | undefined;
          if (action === 'getContent') {
            const match = result.stdout.match(/PAGE_CONTENT_START\n([\s\S]*?)\nPAGE_CONTENT_END/);
            pageContent = match?.[1]?.trim();
          }
          
          // Extract accessibility if getAccessibility action
          let accessibility: any;
          if (action === 'getAccessibility') {
            const match = result.stdout.match(/ACCESSIBILITY_START\n([\s\S]*?)\nACCESSIBILITY_END/);
            if (match?.[1]) {
              try {
                accessibility = JSON.parse(match[1]);
              } catch {
                accessibility = match[1];
              }
            }
          }
          
          // Analyze screenshot if taken
          let analysis: string | undefined;
          if (screenshotAfter && result.stdout.includes('SCREENSHOT_SAVED')) {
            log(`      Analyzing page state...`, 'dim');
            
            const imageResult = await runInSandbox('base64 -w 0 /tmp/browser-action.png 2>&1');
            if (imageResult.exitCode === 0 && imageResult.stdout) {
              try {
                const analysisResult = await generateText({
                  model: 'anthropic/claude-sonnet-4-20250514' as any,
                  messages: [
                    {
                      role: 'user',
                      content: [
                        { type: 'text', text: `This is a screenshot after performing the action "${action}". Briefly describe what you see and whether the action appears to have worked.` },
                        { type: 'image', image: `data:image/png;base64,${imageResult.stdout.trim()}` },
                      ],
                    },
                  ],
                });
                analysis = analysisResult.text;
                log(`      Analysis complete`, 'green');
                // Show a preview of the analysis
                const analysisPreview = analysisResult.text.slice(0, 200) + (analysisResult.text.length > 200 ? '...' : '');
                log(`      Vision: ${analysisPreview}`, 'dim');
              } catch (e: any) {
                analysis = `Screenshot taken but analysis failed: ${e.message}`;
              }
            }
          }
          
          return {
            success: true, 
            action,
            pageContent,
            accessibility,
            analysis,
          };
        } catch (error: any) {
          log(`  [x] Browser action failed: ${error.message}`, 'red');
          return { success: false, error: error.message };
        }
      },
    }),

    markComplete: tool({
      description: 'Mark the task as complete with a summary of what was done',
      inputSchema: z.object({
        summary: z.string().describe('Summary of what was accomplished'),
        filesModified: z.array(z.string()).describe('List of files that were modified'),
      }),
      execute: async ({ summary, filesModified }) => {
        log(`  [+] Task marked complete`, 'green');
        return { complete: true, summary, filesModified };
      },
    }),
  };
}

export type CodingTools = ReturnType<typeof createCodingAgentTools>;

