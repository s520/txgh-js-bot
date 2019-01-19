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

const stringReplaceAsync = require('string-replace-async');
const TransifexApi = require('transifex-js-client');
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
    var addModResources = {};
    for (let commit of commits) {
        app.log("processing commit");
        for (let file of commit.added) {
            app.log("processing added file: " + file);
            if (file.match(fileFilter) && file.match(extFilter)) {
                addModResources[file] = commit.tree_id;
            }
        }
        for (let file of commit.modified) {
            app.log("processing modified file: " + file);
            if (file.match(fileFilter) && file.match(extFilter)) {
                addModResources[file] = commit.tree_id;
            }
        }
    }
    return addModResources
}

/**
 * 対象ファイルをGitHubから取得しTransifexへアップロードする関数
 * @param {function(): string} app - GitHub App
 * @param {Object} githubApi - GitHubAPI
 * @param {string} repoOwner - リポジトリのオーナー名
 * @param {string} repoName - リポジトリ名
 * @param {Object.<string, string>} resources - キーがファイルパス、値がgit treeのSHA、のオブジェクト
 * @returns
 */
async function UpdateResources(app, githubApi, repoOwner, repoName, resources) {
    for (let resourcePath of Object.keys(resources)) {
        app.log("process updated resource");
        const tree = await githubApi.gitdata.getTree({
            owner: repoOwner,
            repo: repoName,
            tree_sha: resources[resourcePath],
            recursive: 1
        });
        for (let file of tree.data.tree) {
            app.log("process each tree entry: " + file.path);
            if (file.path == resourcePath) {
                app.log("process resource file: " + resourcePath);
                const blob = await githubApi.gitdata.getBlob({
                    owner: repoOwner,
                    repo: repoName,
                    file_sha: file.sha
                });
                var content = new Buffer(blob.data.content, blob.data.encoding).toString();
                await UploadResource(resourcePath, content);
                app.log("updated tx_resource: " + resourcePath);
            }
        }
    }
    return;
}

/**
 * ファイルパスからTransifexのリソースSlugを生成する関数
 * @param {string} resourcePath - ファイルパス
 * @returns {string} TransifexのリソースSlug
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
 * @returns
 */
async function UploadResource(resourcePath, content) {
    const resourceSlug = await GenarateResourceSlug(resourcePath);
    await txApi.resource(TX_PROJECT_SLUG, resourceSlug)
        .catch(async () => {
            await txApi.resourceCreate(TX_PROJECT_SLUG, {
                slug: resourceSlug,
                name: resourcePath,
                i18n_type: TX_RESOURCE_TYPE,
                content: content
            });
            return;
        })
    await txApi.resourceSourceStringsUpdate(TX_PROJECT_SLUG, resourceSlug, {
        content: content
    });
    return;
}

/**
 * ヘッドコミットのgit treeに存在する対象ファイルのファイルパスとリソースSlugを取得する関数
 * @param {function(): string} app - GitHub App
 * @param {Object} githubApi - GitHubAPI
 * @param {string} repoOwner - リポジトリのオーナー名
 * @param {string} repoName - リポジトリ名
 * @param {string} headTreeSha - ヘッドコミットのgit treeのSHA
 * @returns {Object.<string, string>} キーがファイルパス、値がリソースSlug、のオブジェクト
 */
async function AllResources(app, githubApi, repoOwner, repoName, headTreeSha) {
    var allResources = {};
    const tree = await githubApi.gitdata.getTree({
        owner: repoOwner,
        repo: repoName,
        tree_sha: headTreeSha,
        recursive: 1
    });
    for (let file of tree.data.tree) {
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
 * @returns {Object.<string, string>} キーが翻訳ファイルパス、値が翻訳ファイルの中身、のオブジェクト
 */
async function AllTranslations(app, resources) {
    var allTranslations = {};
    app.log("process get all translations");
    for (let resourcePath of Object.keys(resources)) {
        app.log("process get translations: " + resourcePath);
        for (let lang of TX_TARGET_LANG) {
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
 * @returns
 */
async function CommitTranslations(app, githubApi, repoOwner, repoName, headSha, headTreeSha, translations) {
    app.log("process commit all translations");
    const tree = await githubApi.gitdata.createTree({
        owner: repoOwner,
        repo: repoName,
        base_tree: headTreeSha,
        tree: Object.keys(translations).map(path => {
            return {
                path,
                mode: "100644",
                content: translations[path]
            };
        })
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
    return;
}

module.exports = app => {
    app.on('push', async context => {
        if (context.payload.pusher.name.match(/\[bot\]/)) {
            return;
        }
        var branch = context.payload.ref.replace(/^refs\//, "");
        app.log("request github branch: " + branch);
        app.log("config github branch: " + GITHUB_BRANCH);
        var branchFilter = new RegExp(GITHUB_BRANCH);
        if (!branch.match(branchFilter)) {
            return;
        }
        var repoOwner = context.payload.repository.owner.name;
        var repoName = context.payload.repository.name;
        const addModResources = AddModResources(app, context.payload.commits);
        await UpdateResources(app, context.github, repoOwner, repoName, addModResources);
        const allResources = await AllResources(app, context.github, repoOwner, repoName, context.payload.head_commit.tree_id);
        const allTranslations = await AllTranslations(app, allResources);
        await CommitTranslations(app, context.github, repoOwner, repoName, context.payload.head_commit.id, context.payload.head_commit.tree_id, allTranslations);
    });
}