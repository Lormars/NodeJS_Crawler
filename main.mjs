import { createReadStream, promises as fsPromises } from "node:fs";
import { lookup } from "mime-types";
import { resolve, dirname } from "node:path";
import neo4j from "neo4j-driver";
import os from 'os';

const { stat } = fsPromises;
const homedir = os.homedir();
const basePath = `${homedir}/.config/ags/`;
let file = `${homedir}/.config/ags/config.js`;

const crawler = Object.create(null);
crawler.importsGraph = Object.create(null);
crawler.getImportsGraph = function () {
  return this.importsGraph;
};
crawler.processedFiles = new Set();

///////////////////////////neo4j setup////////////////////////////////////
const URI = 'neo4j://localhost:7687' //todo: use your own neo4j url
const USER = 'neo4j' //todo: use your own db username
const PASSWORD = 'rootpass' //todo: user your own db password
let driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));

async function uploadImportsGraphToNeo4j(importsGraph) {
    const session = driver.session();

    try {
        for (const [sourceFile, importedFiles] of Object.entries(importsGraph)) {
            // Ensure the source file node exists
            await session.run(
                'MERGE (:File {path: $path})',
                { path: sourceFile }
            );

            // Create nodes for each imported file and the relationships
            for (const targetFile of importedFiles) {
                await session.run(
                    `MERGE (source:File {path: $sourcePath})
                     MERGE (target:File {path: $targetPath})
                     MERGE (source)-[:IMPORTS]->(target)`,
                    { sourcePath: sourceFile, targetPath: targetFile }
                );
            }
        }
    } finally {
        await session.close();
    }
}

//////////////////////////neo4j setup////////////////////////////////////

function readFileContents(stream) {
    return new Promise((resolve, reject) => {
        let content = '';
        stream.on('data', (chunk) => {
            content += chunk.toString();
        });
        stream.on('end', () => {
            resolve(content);
        });
        stream.on('error', reject);
    });
}

crawler.parse = async function(file, currentBasePath = basePath) {
    let path = file;
    let stats;
    try {
        stats = await stat(path);
    } catch (error) {
        if (error.code != "ENOENT") throw error;
        else {
            console.log("File not found: " + path);
            return { status: 404, body: "File not found" };
        }
    }

    if (stats.isDirectory()) {
        return { status: 400, body: "Expected a file, but got a directory" };
    } else {
        if (lookup(path) !== "application/javascript") {
            return { status: 400, body: "Expected a JavaScript file" };
        }
        console.log("Processing file: " + path);
        return { status: 200, body: createReadStream(path) };
    }
};

const extract = async function(content, currentFilePath) {
    if (crawler.processedFiles.has(currentFilePath)) {
        console.log("skipping already processed files: " + currentFilePath);
        return;
    }

    crawler.processedFiles.add(currentFilePath);

    const regex = /import\s+.*?from\s+['"](\.+\/[^']+?)['"]/g;
    const matches = [...content.matchAll(regex)];
    for (const match of matches) {
        const relativePath = match[1];
        const absolutePath = resolve(dirname(currentFilePath), relativePath);
        console.log("Now searching for: " + absolutePath);

        //update the imports graph
        if (!crawler.importsGraph[currentFilePath]) {
            crawler.importsGraph[currentFilePath] = [absolutePath];
        } else if (!crawler.importsGraph[currentFilePath].includes(absolutePath)) {
            crawler.importsGraph[currentFilePath].push(absolutePath);
        }

        const { status, body } = await crawler.parse(absolutePath, dirname(absolutePath));
        if (status === 200) {
            const fileContent = await readFileContents(body);
            console.log('Successfully collected contents of: ' + absolutePath);
            await extract(fileContent, absolutePath); // Note the await here
        } else {
            console.log(body);
        }
    }
};

let pendingOperations = [];


// Initial call to parse the first file
crawler.parse(file, dirname(file))
    .then(({ status, body }) => {
        if (status === 200) {
            readFileContents(body).then(content => {
                pendingOperations.push(extract(content, file));
                Promise.all(pendingOperations).then(() => {
                    console.log(JSON.stringify(crawler.getImportsGraph(), null, 2));
                    uploadImportsGraphToNeo4j(crawler.importsGraph)
                        .then(() => console.log("Import graph uploaded to Neo4j."))
                        .catch(error => console.error("Failed to upload import graph to Neo4j:", error))
                        .finally(() => driver.close());

                });
            });
        } else {
            console.log(body);
        }
    })
    .catch(error => {
        console.log(error);
    });

