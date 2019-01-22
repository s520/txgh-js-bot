"use strict";
require("dotenv").config();

const TX_BASE_URL = process.env.TX_BASE_URL;
const TX_USERNAME = process.env.TX_USERNAME;
const TX_PASSWORD = process.env.TX_PASSWORD;
const TX_PROJECT_SLUG = process.env.TX_PROJECT_SLUG;
const TX_RESOURCE_REG = process.env.TX_RESOURCE_REG;
const TX_RESOURCE_LANG = process.env.TX_RESOURCE_LANG;
const TX_RESOURCE_TYPE = process.env.TX_RESOURCE_TYPE;
const TX_RESOURCE_EXT = process.env.TX_RESOURCE_EXT;
const TX_ALL_UPDATE = process.env.TX_ALL_UPDATE || false;
const TX_TARGET_PATH = process.env.TX_TARGET_PATH;
const TX_WEBHOOK_PATH = "/transifex";
const GITHUB_INSTALL_ID = process.env.GITHUB_INSTALL_ID;
const [GITHUB_REPO_OWNER, GITHUB_REPO_NAME] = process.env.GITHUB_REPO.split("/");
const GITHUB_BRANCH = process.env.GITHUB_BRANCH;
const GITHUB_WEBHOOK_PATH = "/github";
const GITHUB_WEBHOOK_PROXY_URL = process.env.GITHUB_WEBHOOK_PROXY_URL;
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "development";

const fs = require("fs");
const md5 = require("md5");
const crypto = require("crypto");
const stringReplaceAsync = require("string-replace-async");

const Logger = require("bunyan");
const BunyanFormat = require("bunyan-format");
const SupportsColor = require("supports-color");
const logger = Logger.createLogger({
    name: "bot",
    level: process.env.LOG_LEVEL || "info",
    stream: new BunyanFormat({ outputMode: (process.env.LOG_FORMAT || "short"), color: SupportsColor.stdout })
});

const GitHubApp = require("github-app");
const app = new GitHubApp({
    id: process.env.APP_ID,
    cert: process.env.PRIVATE_KEY || fs.readFileSync(process.env.PRIVATE_KEY_PATH)
});

const GitHubWebhooksApi = require("@octokit/webhooks");
const githubWebhooks = new GitHubWebhooksApi({
    secret: WEBHOOK_SECRET,
    path: GITHUB_WEBHOOK_PATH
});

const TransifexApi = require("transifex-js-client");
const txApi = TransifexApi({
    username: TX_USERNAME,
    password: TX_PASSWORD,
    base_url: TX_BASE_URL
});

const createWebhookProxy = (url, path) => {
    try {
        const SmeeClient = require("smee-client");  // eslint-disable-line
        const smee = new SmeeClient({
            logger,
            source: url,
            target: `http://localhost:${PORT}${path}`
        });
        smee.start();
    } catch (err) {
        logger.warn("Run `npm install --save-dev smee-client` to proxy webhooks to localhost.");
    }
};

const express = require("express");
const server = express();
server.use(githubWebhooks.middleware);

const bodyParser = require("body-parser");
server.use(TX_WEBHOOK_PATH, bodyParser.raw({ type: "application/json" }));

/**
 * TransifexのWebhookを検証する関数
 * @param {Object} req - Webhookへのリクエスト
 * @param {string} secret - Webhookの秘密鍵
 * @returns {boolean} 検証結果
 */
const VerifyTxWebhook = (req, secret) => {
    const actualSig = req.headers["x-tx-signature-v2"];
    const url = req.headers["x-tx-url"];
    const date = req.headers.date;
    const data = Buffer.from(req.body).toString();
    logger.info("Actual signature: " + actualSig);
    const contentMd5 = md5(data);
    const msg = ["POST", url, date, contentMd5].join("\n");
    const hmac = crypto.createHmac("sha256", secret);
    const expectedSig = hmac.update(msg).digest().toString("base64");
    logger.info("Expected signature: " + expectedSig);
    return actualSig == expectedSig;
};

const fileFilter = new RegExp(TX_RESOURCE_REG.replace(new RegExp("<lang>", "g"), TX_RESOURCE_LANG));
const extFilter = new RegExp("\\" + TX_RESOURCE_EXT);
const pathToSlug = new RegExp("/|\\.", "g");

/**
 * Pushイベントに含まれるコミットで追加or編集され且つTransifexへアップロードすべきファイルを検出する関数
 * @param {Array.<Object>} commits - Pushイベントに含まれるコミットオブジェクトの配列
 * @returns {Object.<string, string>} キーがファイルパス、値がgit treeのSHA、のオブジェクト
 */
const AddModResources = (commits) => {
    const addModResources = {};
    for (const commit of commits) {
        logger.info("processing commit");
        for (const file of commit.added) {
            logger.info("processing added file: " + file);
            if (file.match(fileFilter) && file.match(extFilter)) {
                addModResources[file] = commit.tree_id;
            }
        }
        for (const file of commit.modified) {
            logger.info("processing modified file: " + file);
            if (file.match(fileFilter) && file.match(extFilter)) {
                addModResources[file] = commit.tree_id;
            }
        }
    }
    return addModResources;
};

/**
 * ファイルパスからTransifexのリソースSlugを生成する関数
 * @param {string} resourcePath - ファイルパス
 * @returns {Promise<string>} TransifexのリソースSlug
 */
const GenarateResourceSlug = async (resourcePath) => {
    const resource = await stringReplaceAsync(resourcePath, fileFilter, "");
    const resourceSlug = await stringReplaceAsync(resource, pathToSlug, "-");
    return (resourceSlug);
};

/**
 * Transifexに存在しないファイルは新規に作成し、既存のファイルはアップデートする関数
 * @param {string} resourcePath - リソースファイルのファイルパス
 * @param {string} content - リソースファイルの中身
 * @returns {Promise<void>} Promiseのインスタンス
 */
const UploadResource = async (resourcePath, content) => {
    const resourceSlug = await GenarateResourceSlug(resourcePath);
    await txApi.resource(TX_PROJECT_SLUG, resourceSlug)
        .catch(async () => {
            await txApi.resourceCreate(TX_PROJECT_SLUG, {
                slug: resourceSlug,
                name: resourcePath,
                i18n_type: TX_RESOURCE_TYPE,
                content
            });
        });
    await txApi.resourceSourceStringsUpdate(TX_PROJECT_SLUG, resourceSlug, {
        content
    });
};

/**
 * 対象ファイルをGitHubから取得しTransifexへアップロードする関数
 * @param {Object} githubApi - GitHubAPI
 * @param {Object.<string, string>} resources - キーがファイルパス、値がgit treeのSHA、のオブジェクト
 * @returns {Promise<void>} Promiseのインスタンス
 */
const UpdateResources = async (githubApi, resources) => {
    for (const [resourcePath, treeSha] of Object.entries(resources)) {
        logger.info("process updated resource");
        const tree = await githubApi.gitdata.getTree({
            owner: GITHUB_REPO_OWNER,
            repo: GITHUB_REPO_NAME,
            tree_sha: treeSha,
            recursive: 1
        });
        for (const file of tree.data.tree) {
            logger.info("process each tree entry: " + file.path);
            if (file.path == resourcePath) {
                logger.info("process resource file: " + resourcePath);
                const blob = await githubApi.gitdata.getBlob({
                    owner: GITHUB_REPO_OWNER,
                    repo: GITHUB_REPO_NAME,
                    file_sha: file.sha
                });
                const content = Buffer.from(blob.data.content, blob.data.encoding).toString();
                await UploadResource(resourcePath, content);
                logger.info("updated tx_resource: " + resourcePath);
            }
        }
    }
};

/**
 * 全てのリソースファイルをGitHubから取得しTransifexへアップロードする関数
 * @param {Object} githubApi - GitHubAPI
 * @param {string} headTreeSha - ヘッドコミットのgit treeのSHA
 * @returns {Promise<void>} Promiseのインスタンス
 */
const AllUpdateResources = async (githubApi, headTreeSha) => {
    logger.info("process updated all resources");
    const tree = await githubApi.gitdata.getTree({
        owner: GITHUB_REPO_OWNER,
        repo: GITHUB_REPO_NAME,
        tree_sha: headTreeSha,
        recursive: 1
    });
    for (const file of tree.data.tree) {
        logger.info("process each tree entry: " + file.path);
        if (file.path.match(fileFilter) && file.path.match(extFilter)) {
            logger.info("process resource file: " + file.path);
            const blob = await githubApi.gitdata.getBlob({
                owner: GITHUB_REPO_OWNER,
                repo: GITHUB_REPO_NAME,
                file_sha: file.sha
            });
            const content = Buffer.from(blob.data.content, blob.data.encoding).toString();
            await UploadResource(file.path, content);
            logger.info("updated tx_resource: " + file.path);
        }
    }
};

/**
 * ヘッドコミットのgit treeに存在する対象ファイルのファイルパスとリソースSlugを取得する関数
 * @param {Object} githubApi - GitHubAPI
 * @param {string} headTreeSha - ヘッドコミットのgit treeのSHA
 * @returns {Promise<Object.<string, string>>} キーがファイルパス、値がリソースSlug、のオブジェクト
 */
const AllResources = async (githubApi, headTreeSha) => {
    const allResources = {};
    const tree = await githubApi.gitdata.getTree({
        owner: GITHUB_REPO_OWNER,
        repo: GITHUB_REPO_NAME,
        tree_sha: headTreeSha,
        recursive: 1
    });
    for (const file of tree.data.tree) {
        logger.info("process each tree entry: " + file.path);
        if (file.path.match(fileFilter) && file.path.match(extFilter)) {
            allResources[file.path] = await GenarateResourceSlug(file.path);
        }
    }
    return (allResources);
};

/**
 * Transifexの翻訳対象言語のリストを取得する関数
 * @returns {Promise<Array.<string>>} 翻訳対象言語のリスト
 */
const AllLanguages = async () => {
    logger.info("process get all languages");
    const result = await txApi.project(TX_PROJECT_SLUG);
    logger.info("got all languages");
    return result.data.teams;
};

/**
 * ファイルのSHA1がGitHub上のファイルのものと一致するか確認する関数
 * @param {Object} githubApi - GitHubAPI
 * @param {string} path - GitHub上のファイルパス
 * @param {string} newContent ファイルの文字列
 * @returns {Promise<boolean>} 検証結果
 */
const VerifySHA1 = async (githubApi, path, newContent) => {
    const shasum = crypto.createHash("sha1");
    const lengh = Buffer.byteLength(newContent);
    const newHash = shasum.update(Buffer.from("blob " + lengh + "\x00" + newContent)).digest("hex");
    const currentContent = await githubApi.repos.getContents({
        owner: GITHUB_REPO_OWNER,
        repo: GITHUB_REPO_NAME,
        path,
        ref: GITHUB_BRANCH
    });
    return newHash == currentContent.data.sha;
};

/**
 * Transifexから対象ファイルの翻訳ファイルを取得する関数
 * @param {Object} githubApi - GitHubAPI
 * @param {Object.<string, string>} resources - キーがファイルパス、値がリソースSlug、のオブジェクト
 * @param {Array.<string>} languages - 翻訳対象言語のリスト
 * @returns {Promise<Object.<string, string>>} キーが翻訳ファイルパス、値が翻訳ファイルの中身、のオブジェクト
 */
const AllTranslations = async (githubApi, resources, languages) => {
    const allTranslations = {};
    logger.info("process get all translations");
    for (const [resourcePath, resourceSlug] of Object.entries(resources)) {
        logger.info("process get translations: " + resourcePath);
        for (const lang of languages) {
            logger.info("process get translations: " + lang);
            if (lang != TX_RESOURCE_LANG) {
                const result = await txApi.translation(TX_PROJECT_SLUG, resourceSlug, lang);
                const filePath = resourcePath.replace(fileFilter, TX_TARGET_PATH.replace(new RegExp("<lang>", "g"), lang));
                if (!VerifySHA1(githubApi, filePath, result.data)) {
                    allTranslations[filePath] = result.data;
                }
                logger.info("got translation:" + resourcePath);
            }
        }
    }
    return (allTranslations);
};

/**
 * 翻訳ファイルをGitHubへコミットする関数
 * @param {Object} githubApi - GitHubAPI
 * @param {string} headSha - ヘッドコミットのSHA
 * @param {string} headTreeSha - ヘッドコミットのgit treeのSHA
 * @param {Object.<string, string>} translations - キーが翻訳ファイルパス、値が翻訳ファイルの中身、のオブジェクト
 * @returns {Promise<void>} Promiseのインスタンス
 */
const CommitTranslations = async (githubApi, headSha, headTreeSha, translations) => {
    logger.info("process commit all translations");
    if (Object.keys(translations).length > 0) {
        const tree = await githubApi.gitdata.createTree({
            owner: GITHUB_REPO_OWNER,
            repo: GITHUB_REPO_NAME,
            base_tree: headTreeSha,
            tree: Object.keys(translations).map(path => ({
                path,
                mode: "100644",
                content: translations[path]
            }))
        });
        const commit = await githubApi.gitdata.createCommit({
            owner: GITHUB_REPO_OWNER,
            repo: GITHUB_REPO_NAME,
            message: "Update translations from transifex",
            tree: tree.data.sha,
            parents: [headSha]
        });
        await githubApi.gitdata.updateRef({
            owner: GITHUB_REPO_OWNER,
            repo: GITHUB_REPO_NAME,
            ref: "heads/" + GITHUB_BRANCH,
            sha: commit.data.sha
        });
    }
    logger.info("commited all translations");
};

/**
 * コミットステータスを作成する関数
 * @param {Object} githubApi - GitHubAPI
 * @param {string} headSha - ヘッドコミットのSHA
 * @param {string} state - コミットステータス
 * @param {string} description - コミットステータスの説明
 * @returns {Promise<void>} Promiseのインスタンス
 */
const CreateCommitStatus = async (githubApi, headSha, state, description) => {
    logger.info("process update commit status");
    await githubApi.repos.createStatus({
        owner: GITHUB_REPO_OWNER,
        repo: GITHUB_REPO_NAME,
        sha: headSha,
        state,
        description,
        context: "txgh-js-bot"
    });
    logger.info("updated commit status");
};

githubWebhooks.on("push", async event => {
    if (event.payload.pusher.name.match(/\[bot\]/)) {
        return;
    }
    const branch = event.payload.ref.replace(/^refs\//, "");
    logger.info("request github branch: " + branch);
    logger.info("config github branch: " + GITHUB_BRANCH);
    const branchFilter = new RegExp(GITHUB_BRANCH);
    if (!branch.match(branchFilter)) {
        return;
    }
    if (event.payload.installation.id != GITHUB_INSTALL_ID ||
        event.payload.repository.owner.name != GITHUB_REPO_OWNER ||
        event.payload.repository.name != GITHUB_REPO_NAME) {
        throw new Error("Environment variable setting is wrong.");
    }
    const github = await app.asInstallation(GITHUB_INSTALL_ID);
    const headSha = event.payload.head_commit.id;
    const headTreeSha = event.payload.head_commit.tree_id;
    await CreateCommitStatus(github, headSha, "pending", "The process has started.");
    if (!TX_ALL_UPDATE) {
        const addModResources = AddModResources(event.payload.commits);
        await UpdateResources(github, addModResources)
            .catch(async () => {
                const message = "Failed to upload to Transifex.";
                await CreateCommitStatus(github, headSha, "failure", message);
                logger.fatal(message);
                throw new Error(message);
            });
    } else {
        await AllUpdateResources(github, headTreeSha)
            .catch(async () => {
                const message = "Failed to upload all resource files to Transifex.";
                await CreateCommitStatus(github, headSha, "failure", message);
                logger.fatal(message);
                throw new Error(message);
            });
    }
    const allResources = await AllResources(github, headTreeSha)
        .catch(async () => {
            const message = "Failed to acquire the path of the target file on GitHub.";
            await CreateCommitStatus(github, headSha, "failure", message);
            logger.fatal(message);
            throw new Error(message);
        });
    const allLanguages = await AllLanguages()
        .catch(async () => {
            const message = "Failed to get the list of languages to be translated from Transifex.";
            await CreateCommitStatus(github, headSha, "failure", message);
            logger.fatal(message);
            throw new Error(message);
        });
    const allTranslations = await AllTranslations(github, allResources, allLanguages)
        .catch(async () => {
            const message = "Failed to download the translation file on Transifex.";
            await CreateCommitStatus(github, headSha, "failure", message);
            logger.fatal(message);
            throw new Error(message);
        });
    await CommitTranslations(github, headSha, headTreeSha, allTranslations)
        .catch(async () => {
            const message = "Failed to commit the translation file to GitHub.";
            await CreateCommitStatus(github, headSha, "failure", message);
            logger.fatal(message);
            throw new Error(message);
        });
    await CreateCommitStatus(github, headSha, "success", "All processes are completed.");
});

server.post(TX_WEBHOOK_PATH, async (req, res) => {
    logger.info("process start by Transifex's Webhook");

    const body = JSON.parse(req.body);
    const resourceSlug = body.resource;
    const lang = body.language;

    logger.info("process verify Transifex's Webhook");
    if (!VerifyTxWebhook(req, WEBHOOK_SECRET) || body.project != TX_PROJECT_SLUG || lang == TX_RESOURCE_LANG) {
        res.status(400).send("Bad Request");
        return;
    }
    logger.info("verified Webhook");

    logger.info("process get resource file information from Transifex");
    const resource = await txApi.resource(TX_PROJECT_SLUG, resourceSlug)
        .catch(() => {
            const message = "Failed to get resource file information from Transifex.";
            logger.fatal(message);
            res.status(500).send("Internal Server Error");
            throw new Error(message);
        });
    logger.info("got resource file infomation");

    if (!resource.data.name.match(fileFilter) || !resource.data.name.match(extFilter)) {
        res.status(400).send("Bad Request");
        return;
    }

    logger.info("process download the translation file on Transifex");
    const translation = await txApi.translation(TX_PROJECT_SLUG, resourceSlug, lang)
        .catch(() => {
            const message = "Failed to download the translation file on Transifex.";
            logger.fatal(message);
            res.status(500).send("Internal Server Error");
            throw new Error(message);
        });
    logger.info("downloaded the translation file");

    const translationPath = resource.data.name.replace(fileFilter, TX_TARGET_PATH.replace(new RegExp("<lang>", "g"), lang));
    const github = await app.asInstallation(GITHUB_INSTALL_ID);

    logger.info("process get information on translation file from GitHub");
    const content = await github.repos.getContents({
        owner: GITHUB_REPO_OWNER,
        repo: GITHUB_REPO_NAME,
        path: translationPath,
        ref: GITHUB_BRANCH
    }).catch(() => {
        const message = "Failed to get information on translation file from GitHub.";
        logger.fatal(message);
        res.status(500).send("Internal Server Error");
        throw new Error(message);
    });
    logger.info("got information on translation file");

    logger.info("process commit the translation file to GitHub");
    await github.repos.updateFile({
        owner: GITHUB_REPO_OWNER,
        repo: GITHUB_REPO_NAME,
        path: translationPath,
        message: "Update translation from transifex",
        content: Buffer.from(translation.data).toString("base64"),
        sha: content.data.sha,
        branch: GITHUB_BRANCH
    }).catch(() => {
        const message = "Failed to commit the translation file to GitHub.";
        logger.fatal(message);
        res.status(500).send("Internal Server Error");
        throw new Error(message);
    });
    logger.info("commited the translation file");

    res.status(200).send("OK");
});

if (GITHUB_WEBHOOK_PROXY_URL) {
    createWebhookProxy(GITHUB_WEBHOOK_PROXY_URL, GITHUB_WEBHOOK_PATH);
}

server.listen(PORT);
logger.info("Listening on http://localhost:" + PORT);
