"use strict";
const TX_BASE_URL = process.env.TX_BASE_URL;
const TX_USERNAME = process.env.TX_USERNAME;
const TX_PASSWORD = process.env.TX_PASSWORD;
const TX_PROJECT_SLUG = process.env.TX_PROJECT_SLUG;
const TX_RESOURCE_REG = process.env.TX_RESOURCE_REG;
const TX_RESOURCE_LANG = process.env.TX_RESOURCE_LANG;
const TX_RESOURCE_TYPE = process.env.TX_RESOURCE_TYPE;
const TX_RESOURCE_EXT = process.env.TX_RESOURCE_EXT;
const TX_TARGET_LANG = process.env.TX_TARGET_LANG.split(",");
const TX_TARGET_PATH = process.env.TX_TARGET_PATH;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH;

const stringReplaceAsync = require("string-replace-async");
const TransifexApi = require("transifex-js-client");
const txApi = TransifexApi({
    username: TX_USERNAME,
    password: TX_PASSWORD,
    base_url: TX_BASE_URL
});

const fileFilter = new RegExp(TX_RESOURCE_REG.replace(new RegExp("<lang>", "g"), TX_RESOURCE_LANG));
const extFilter = new RegExp("\\" + TX_RESOURCE_EXT);
const pathToSlug = new RegExp("/|\\.", "g");

/**
 * Pushイベントに含まれるコミットで追加or編集され且つTransifexへアップロードすべきファイルを検出する関数
 * @param {function(): string} app - GitHub App
 * @param {Array.<Object>} commits - Pushイベントに含まれるコミットオブジェクトの配列
 * @returns {Object.<string, string>} キーがファイルパス、値がgit treeのSHA、のオブジェクト
 */
function AddModResources(app, commits) {
    const addModResources = {};
    for (const commit of commits) {
        app.log("processing commit");
        for (const file of commit.added) {
            app.log("processing added file: " + file);
            if (file.match(fileFilter) && file.match(extFilter)) {
                addModResources[file] = commit.tree_id;
            }
        }
        for (const file of commit.modified) {
            app.log("processing modified file: " + file);
            if (file.match(fileFilter) && file.match(extFilter)) {
                addModResources[file] = commit.tree_id;
            }
        }
    }
    return addModResources;
}

/**
 * ファイルパスからTransifexのリソースSlugを生成する関数
 * @param {string} resourcePath - ファイルパス
 * @returns {Promise<string>} TransifexのリソースSlug
 */
async function GenarateResourceSlug(resourcePath) {
    const resource = await stringReplaceAsync(resourcePath, fileFilter, "");
    const resourceSlug = await stringReplaceAsync(resource, pathToSlug, "-");
    return (resourceSlug);
}

/**
 * Transifexに存在しないファイルは新規に作成し、既存のファイルはアップデートする関数
 * @param {string} resourcePath - リソースファイルのファイルパス
 * @param {string} content - リソースファイルの中身
 * @returns {Promise<void>} Promiseのインスタンス
 */
async function UploadResource(resourcePath, content) {
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
}

/**
 * 対象ファイルをGitHubから取得しTransifexへアップロードする関数
 * @param {function(): string} app - GitHub App
 * @param {Object} githubApi - GitHubAPI
 * @param {string} repoOwner - リポジトリのオーナー名
 * @param {string} repoName - リポジトリ名
 * @param {Object.<string, string>} resources - キーがファイルパス、値がgit treeのSHA、のオブジェクト
 * @returns {Promise<void>} Promiseのインスタンス
 */
async function UpdateResources(app, githubApi, repoOwner, repoName, resources) {
    for (const resourcePath of Object.keys(resources)) {
        app.log("process updated resource");
        const tree = await githubApi.gitdata.getTree({
            owner: repoOwner,
            repo: repoName,
            tree_sha: resources[resourcePath],
            recursive: 1
        });
        for (const file of tree.data.tree) {
            app.log("process each tree entry: " + file.path);
            if (file.path == resourcePath) {
                app.log("process resource file: " + resourcePath);
                const blob = await githubApi.gitdata.getBlob({
                    owner: repoOwner,
                    repo: repoName,
                    file_sha: file.sha
                });
                const content = Buffer.from(blob.data.content, blob.data.encoding).toString();

                await UploadResource(resourcePath, content);
                app.log("updated tx_resource: " + resourcePath);
            }
        }
    }
}


/**
 * ヘッドコミットのgit treeに存在する対象ファイルのファイルパスとリソースSlugを取得する関数
 * @param {function(): string} app - GitHub App
 * @param {Object} githubApi - GitHubAPI
 * @param {string} repoOwner - リポジトリのオーナー名
 * @param {string} repoName - リポジトリ名
 * @param {string} headTreeSha - ヘッドコミットのgit treeのSHA
 * @returns {Promise<Object.<string, string>>} キーがファイルパス、値がリソースSlug、のオブジェクト
 */
async function AllResources(app, githubApi, repoOwner, repoName, headTreeSha) {
    const allResources = {};
    const tree = await githubApi.gitdata.getTree({
        owner: repoOwner,
        repo: repoName,
        tree_sha: headTreeSha,
        recursive: 1
    });
    for (const file of tree.data.tree) {
        app.log("process each tree entry: " + file.path);
        if (file.path.match(fileFilter) && file.path.match(extFilter)) {
            allResources[file.path] = await GenarateResourceSlug(file.path);
        }
    }
    return (allResources);
}

/**
 * Transifexから対象ファイルの翻訳ファイルを取得する関数
 * @param {function(): string} app - GitHub App
 * @param {Object.<string, string>} resources - キーがファイルパス、値がリソースSlug、のオブジェクト
 * @returns {Promise<Object.<string, string>>} キーが翻訳ファイルパス、値が翻訳ファイルの中身、のオブジェクト
 */
async function AllTranslations(app, resources) {
    const allTranslations = {};
    app.log("process get all translations");
    for (const resourcePath of Object.keys(resources)) {
        app.log("process get translations: " + resourcePath);
        for (const lang of TX_TARGET_LANG) {
            app.log("process get translations: " + lang);
            if (lang != TX_RESOURCE_LANG) {
                const result = await txApi.translation(TX_PROJECT_SLUG, resources[resourcePath], lang);
                allTranslations[resourcePath.replace(fileFilter, TX_TARGET_PATH.replace(new RegExp("<lang>", "g"), lang))] = result.data;
                app.log("got translation:" + resourcePath);
            }
        }
    }
    return (allTranslations);
}

/**
 * 翻訳ファイルをGitHubへコミットする関数
 * @param {function(): string} app - GitHub App
 * @param {Object} githubApi - GitHubAPI
 * @param {string} repoOwner - リポジトリのオーナー名
 * @param {string} repoName - リポジトリ名
 * @param {string} headSha - ヘッドコミットのSHA
 * @param {string} headTreeSha - ヘッドコミットのgit treeのSHA
 * @param {Object.<string, string>} translations - キーが翻訳ファイルパス、値が翻訳ファイルの中身、のオブジェクト
 * @returns {Promise<void>} Promiseのインスタンス
 */
async function CommitTranslations(app, githubApi, repoOwner, repoName, headSha, headTreeSha, translations) {
    app.log("process commit all translations");
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
    app.log("commited all translations");
}

/**
 * コミットステータスを作成する関数
 * @param {function(): string} app - GitHub App
 * @param {Object} githubApi - GitHubAPI
 * @param {string} repoOwner - リポジトリのオーナー名
 * @param {string} repoName - リポジトリ名
 * @param {string} headSha - ヘッドコミットのSHA
 * @param {string} state - コミットステータス
 * @param {string} description - コミットステータスの説明
 * @returns {Promise<void>} Promiseのインスタンス
 */
async function CreateCommitStatus(app, githubApi, repoOwner, repoName, headSha, state, description) {
    app.log("process update commit status");
    await githubApi.repos.createStatus({
        owner: repoOwner,
        repo: repoName,
        sha: headSha,
        state,
        description,
        context: "txgh-js-bot"
    });
    app.log("updated commit status");
}

module.exports = app => {
    app.on("push", async context => {
        if (context.payload.pusher.name.match(/\[bot\]/)) {
            return;
        }
        const branch = context.payload.ref.replace(/^refs\//, "");
        app.log("request github branch: " + branch);
        app.log("config github branch: " + GITHUB_BRANCH);
        const branchFilter = new RegExp(GITHUB_BRANCH);
        if (!branch.match(branchFilter)) {
            return;
        }
        const repoOwner = context.payload.repository.owner.name;
        const repoName = context.payload.repository.name;
        const headSha = context.payload.head_commit.id;
        await CreateCommitStatus(app, context.github, repoOwner, repoName, headSha, "pending", "The process has started.");
        const addModResources = AddModResources(app, context.payload.commits);
        await UpdateResources(app, context.github, repoOwner, repoName, addModResources)
            .catch(async () => {
                await CreateCommitStatus(app, context.github, repoOwner, repoName, headSha, "failure", "Uploading to Transifex failed.");
                throw new Error("Uploading to Transifex failed.");
            });
        const allResources = await AllResources(app, context.github, repoOwner, repoName, context.payload.head_commit.tree_id)
            .catch(async () => {
                await CreateCommitStatus(app, context.github, repoOwner, repoName, headSha, "failure", "Failed to acquire the path of the target file on GitHub.");
                throw new Error("Failed to acquire the path of the target file on GitHub.");
            });
        const allTranslations = await AllTranslations(app, allResources)
            .catch(async () => {
                await CreateCommitStatus(app, context.github, repoOwner, repoName, headSha, "failure", "Failed to download the translation file on Transifex.");
                throw new Error("Failed to download the translation file on Transifex.");
            });
        await CommitTranslations(app, context.github, repoOwner, repoName, headSha, context.payload.head_commit.tree_id, allTranslations)
            .catch(async () => {
                await CreateCommitStatus(app, context.github, repoOwner, repoName, headSha, "failure", "Failed to commit the translation file to GitHub.");
                throw new Error("Failed to commit the translation file to GitHub.");
            });
        await CreateCommitStatus(app, context.github, repoOwner, repoName, headSha, "success", "All processes are completed.");
    });
};
