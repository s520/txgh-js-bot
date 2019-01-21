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
const TX_WEBHOOK_PROXY_URL = process.env.TX_WEBHOOK_PROXY_URL;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH;
const GITHUB_WEBHOOK_PATH = "/github";
const GITHUB_WEBHOOK_PROXY_URL = process.env.GITHUB_WEBHOOK_PROXY_URL;
const PORT = process.env.PORT || 3000;

const fs = require("fs");
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
    secret: process.env.WEBHOOK_SECRET || "development",
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
 * @param {string} repoOwner - リポジトリのオーナー名
 * @param {string} repoName - リポジトリ名
 * @param {Object.<string, string>} resources - キーがファイルパス、値がgit treeのSHA、のオブジェクト
 * @returns {Promise<void>} Promiseのインスタンス
 */
const UpdateResources = async (githubApi, repoOwner, repoName, resources) => {
    for (const [resourcePath, treeSha] of Object.entries(resources)) {
        logger.info("process updated resource");
        const tree = await githubApi.gitdata.getTree({
            owner: repoOwner,
            repo: repoName,
            tree_sha: treeSha,
            recursive: 1
        });
        for (const file of tree.data.tree) {
            logger.info("process each tree entry: " + file.path);
            if (file.path == resourcePath) {
                logger.info("process resource file: " + resourcePath);
                const blob = await githubApi.gitdata.getBlob({
                    owner: repoOwner,
                    repo: repoName,
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
 * @param {string} repoOwner - リポジトリのオーナー名
 * @param {string} repoName - リポジトリ名
 * @param {string} headTreeSha - ヘッドコミットのgit treeのSHA
 * @returns {Promise<void>} Promiseのインスタンス
 */
const AllUpdateResources = async (githubApi, repoOwner, repoName, headTreeSha) => {
    logger.info("process updated all resources");
    const tree = await githubApi.gitdata.getTree({
        owner: repoOwner,
        repo: repoName,
        tree_sha: headTreeSha,
        recursive: 1
    });
    for (const file of tree.data.tree) {
        logger.info("process each tree entry: " + file.path);
        if (file.path.match(fileFilter) && file.path.match(extFilter)) {
            logger.info("process resource file: " + file.path);
            const blob = await githubApi.gitdata.getBlob({
                owner: repoOwner,
                repo: repoName,
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
 * @param {string} repoOwner - リポジトリのオーナー名
 * @param {string} repoName - リポジトリ名
 * @param {string} headTreeSha - ヘッドコミットのgit treeのSHA
 * @returns {Promise<Object.<string, string>>} キーがファイルパス、値がリソースSlug、のオブジェクト
 */
const AllResources = async (githubApi, repoOwner, repoName, headTreeSha) => {
    const allResources = {};
    const tree = await githubApi.gitdata.getTree({
        owner: repoOwner,
        repo: repoName,
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
 * Transifexから対象ファイルの翻訳ファイルを取得する関数
 * @param {Object.<string, string>} resources - キーがファイルパス、値がリソースSlug、のオブジェクト
 * @param {Array.<string>} languages - 翻訳対象言語のリスト
 * @returns {Promise<Object.<string, string>>} キーが翻訳ファイルパス、値が翻訳ファイルの中身、のオブジェクト
 */
const AllTranslations = async (resources, languages) => {
    const allTranslations = {};
    logger.info("process get all translations");
    for (const [resourcePath, resourceSlug] of Object.entries(resources)) {
        logger.info("process get translations: " + resourcePath);
        for (const lang of languages) {
            logger.info("process get translations: " + lang);
            if (lang != TX_RESOURCE_LANG) {
                const result = await txApi.translation(TX_PROJECT_SLUG, resourceSlug, lang);
                allTranslations[resourcePath.replace(fileFilter, TX_TARGET_PATH.replace(new RegExp("<lang>", "g"), lang))] = result.data;
                logger.info("got translation:" + resourcePath);
            }
        }
    }
    return (allTranslations);
};

/**
 * 翻訳ファイルをGitHubへコミットする関数
 * @param {Object} githubApi - GitHubAPI
 * @param {string} repoOwner - リポジトリのオーナー名
 * @param {string} repoName - リポジトリ名
 * @param {string} headSha - ヘッドコミットのSHA
 * @param {string} headTreeSha - ヘッドコミットのgit treeのSHA
 * @param {Object.<string, string>} translations - キーが翻訳ファイルパス、値が翻訳ファイルの中身、のオブジェクト
 * @returns {Promise<void>} Promiseのインスタンス
 */
const CommitTranslations = async (githubApi, repoOwner, repoName, headSha, headTreeSha, translations) => {
    logger.info("process commit all translations");
    const tree = await githubApi.gitdata.createTree({
        owner: repoOwner,
        repo: repoName,
        base_tree: headTreeSha,
        tree: Object.keys(translations).map(path => ({
            path,
            mode: "100644",
            content: translations[path]
        }))
    });
    const commit = await githubApi.gitdata.createCommit({
        owner: repoOwner,
        repo: repoName,
        message: "Update translations from transifex",
        tree: tree.data.sha,
        parents: [headSha]
    });
    await githubApi.gitdata.updateRef({
        owner: repoOwner,
        repo: repoName,
        ref: "heads/" + GITHUB_BRANCH,
        sha: commit.data.sha
    });
    logger.info("commited all translations");
};

/**
 * コミットステータスを作成する関数
 * @param {Object} githubApi - GitHubAPI
 * @param {string} repoOwner - リポジトリのオーナー名
 * @param {string} repoName - リポジトリ名
 * @param {string} headSha - ヘッドコミットのSHA
 * @param {string} state - コミットステータス
 * @param {string} description - コミットステータスの説明
 * @returns {Promise<void>} Promiseのインスタンス
 */
const CreateCommitStatus = async (githubApi, repoOwner, repoName, headSha, state, description) => {
    logger.info("process update commit status");
    await githubApi.repos.createStatus({
        owner: repoOwner,
        repo: repoName,
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
    const github = await app.asInstallation(event.payload.installation.id);
    const repoOwner = event.payload.repository.owner.name;
    const repoName = event.payload.repository.name;
    const headSha = event.payload.head_commit.id;
    const headTreeSha = event.payload.head_commit.tree_id;
    await CreateCommitStatus(github, repoOwner, repoName, headSha, "pending", "The process has started.");
    if (!TX_ALL_UPDATE) {
        const addModResources = AddModResources(event.payload.commits);
        await UpdateResources(github, repoOwner, repoName, addModResources)
            .catch(async () => {
                const message = "Failed to upload to Transifex.";
                await CreateCommitStatus(github, repoOwner, repoName, headSha, "failure", message);
                logger.fatal(message);
                throw new Error(message);
            });
    } else {
        await AllUpdateResources(github, repoOwner, repoName, headTreeSha)
            .catch(async () => {
                const message = "Failed to upload all resource files to Transifex.";
                await CreateCommitStatus(github, repoOwner, repoName, headSha, "failure", message);
                logger.fatal(message);
                throw new Error(message);
            });
    }
    const allResources = await AllResources(github, repoOwner, repoName, headTreeSha)
        .catch(async () => {
            const message = "Failed to acquire the path of the target file on GitHub.";
            await CreateCommitStatus(github, repoOwner, repoName, headSha, "failure", message);
            logger.fatal(message);
            throw new Error(message);
        });
    const allLanguages = await AllLanguages()
        .catch(async () => {
            const message = "Failed to get the list of languages to be translated from Transifex.";
            await CreateCommitStatus(github, repoOwner, repoName, headSha, "failure", message);
            logger.fatal(message);
            throw new Error(message);
        });
    const allTranslations = await AllTranslations(allResources, allLanguages)
        .catch(async () => {
            const message = "Failed to download the translation file on Transifex.";
            await CreateCommitStatus(github, repoOwner, repoName, headSha, "failure", message);
            logger.fatal(message);
            throw new Error(message);
        });
    await CommitTranslations(github, repoOwner, repoName, headSha, headTreeSha, allTranslations)
        .catch(async () => {
            const message = "Failed to commit the translation file to GitHub.";
            await CreateCommitStatus(github, repoOwner, repoName, headSha, "failure", message);
            logger.fatal(message);
            throw new Error(message);
        });
    await CreateCommitStatus(github, repoOwner, repoName, headSha, "success", "All processes are completed.");
});

if (GITHUB_WEBHOOK_PROXY_URL) {
    createWebhookProxy(GITHUB_WEBHOOK_PROXY_URL, GITHUB_WEBHOOK_PATH);
}

if (TX_WEBHOOK_PROXY_URL) {
    createWebhookProxy(TX_WEBHOOK_PROXY_URL, TX_WEBHOOK_PATH);
}

server.listen(PORT);
logger.info("Listening on http://localhost:" + PORT);
