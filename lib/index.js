const fs = require('fs');
const debug = require('debug')('grok-js');
const async = require('async');
const Map = require('collections/fast-map');
const path = require('path');
const {OnigRegExp} = require('oniguruma');
const {fromCallback} = require('universalify');
const {forEach} = require('async');

function GrokPattern(expression, id) {
    const t = this;

    t.id = id;
    t.expression = expression;
    t.fields = [null]; // add a dummy entry at the beginning to swallow the fully captured expression
    t.resolved = null;
    t.regex = null;

    t.parse = fromCallback(function parse(str, next) {
        if (!t.regexp) {
            t.regexp = new OnigRegExp(t.resolved);
        }

        t.regexp.search(str, (err, result) => {
            if (err || !result) {
                return next(err, result);
            }

            const r = {};

            result.forEach((item, index) => {
                const field = t.fields[index];

                if (field && item.match) {
                    r[field] = item.match;
                }
            });

            return next(err, r, result);
        });
    });

    t.parseSync = str => {
        if (!t.regexp) {
            t.regexp = new OnigRegExp(t.resolved);
        }

        const result = t.regexp.searchSync(str);

        if (!result) {
            return null;
        }

        const r = {};

        result.forEach((item, index) => {
            const field = t.fields[index];
            if (field && item.match) {
                r[field] = item.match;
            }
        });

        return r;
    };
}

const subPatternsRegex = /%\{[A-Z0-9_]+(?::[A-Za-z0-9_]+)?(?::[A-Za-z]+)?\}/g; // %{subPattern} or %{subPattern:fieldName}
const nestedFieldNamesRegex = /(\(\?<([A-Za-z0-9_]+)>)|\(\?:|\(\?>|\(\?!|\(\?<!|\(|\\\(|\\\)|\)|\[|\\\[|\\\]|\]/g;

function GrokCollection() {
    const t = this;
    const patterns = new Map();
    const resolvePattern = pattern => {
        pattern = resolveSubPatterns(pattern);
        pattern = resolveFieldNames(pattern);

        return pattern;
    };

    // detect references to other patterns
    // TODO: support automatic type conversion (e.g., "%{NUMBER:duration:float}"; see: https://www.elastic.co/guide/en/logstash/current/plugins-filters-grok.html)
    const resolveSubPatterns = pattern => {
        if (!pattern) {
            return;
        }

        let expression = pattern.expression;
        const subPatterns = expression.match(subPatternsRegex) || [];

        subPatterns.forEach(matched => {
            // matched is: %{subPatternName} or %{subPatternName:fieldName}
            let subPatternName = matched.substr(2, matched.length - 3);
            const elements = subPatternName.split(':');

            subPatternName = elements[0];

            const fieldName = elements[1];
            const subPattern = patterns.get(subPatternName);

            if (!subPattern) {
                debug('Error: pattern "' + subPatternName + '" not found!');
                return;
            }

            if (!subPattern.resolved) {
                resolvePattern(subPattern);
            }

            if (fieldName) {
                expression = expression.replace(matched, '(?<' + fieldName + '>' + subPattern.resolved + ')');
            } else {
                expression = expression.replace(matched, subPattern.resolved);
            }
        });

        pattern.resolved = expression;
        return pattern;
    };

    // create mapping table for the fieldNames to capture
    const resolveFieldNames = pattern => {
        if (!pattern) {
            return;
        }

        let nestLevel = 0;
        let inRangeDef = 0;
        let matched;

        while ((matched = nestedFieldNamesRegex.exec(pattern.resolved)) !== null) {
            switch (matched[0]) {
                case '(': {
                    if (!inRangeDef) {
                        nestLevel = nestLevel + 1;
                        pattern.fields.push(null);
                    }
                    break;
                }
                case '\\(':
                    break; // can be ignored
                case '\\)':
                    break; // can be ignored
                case ')': {
                    if (!inRangeDef) {
                        nestLevel = nestLevel - 1;
                    }
                    break;
                }
                case '[': {
                    ++inRangeDef;
                    break;
                }
                case '\\[':
                    break; // can be ignored
                case '\\]':
                    break; // can be ignored
                case ']': {
                    --inRangeDef;
                    break;
                }
                case '(?:': // fallthrough                // group not captured
                case '(?>': // fallthrough                // atomic group
                case '(?!': // fallthrough                // negative look-ahead
                case '(?<!': {
                    if (!inRangeDef) {
                        nestLevel = nestLevel + 1;
                    }
                    break;
                } // negative look-behind
                default: {
                    nestLevel++;
                    pattern.fields.push(matched[2]);
                    break;
                }
            }
        }

        return pattern;
    };

    const patternLineRegex = /^([A-Z0-9_]+)\s+(.+)/;
    const splitLineRegex = /\r?\n/;

    const doLoad = file => {
        let i = 0;

        if (file) {
            const lines = file.toString().split(splitLineRegex);

            if (lines && lines.length) {
                lines.forEach(line => {
                    const elements = patternLineRegex.exec(line);
                    console.log(elements);
                    if (elements && elements.length > 2) {
                        const pattern = new GrokPattern(elements[2], elements[1]);

                        patterns.set(pattern.id, pattern);
                        i++;
                    }
                });
            }
        }

        return i;
    };

    t.createPattern = (expression, id) => {
        id = id || 'pattern-' + patterns.length;

        if (patterns.has(id)) {
            debug('Error: pattern with id %s already exists', id);
        } else {
            const pattern = new GrokPattern(expression, id);

            resolvePattern(pattern);
            patterns.set(id, pattern);

            return pattern;
        }
    };

    t.getPattern = id => {
        return resolvePattern(patterns.get(id));
    };

    t.load = fromCallback(function load(filePath, callback) {
        fs.readFile(filePath, (err, file) => {
            if (err) {
                return callback(err);
            }

            doLoad(file);
            return callback();
        });
    });

    t.loadSync = filePath => {
        // console.log(' ---  filePath ----', filePath);
        return doLoad(fs.readFileSync(filePath));
    };

    t.count = () => {
        return patterns.length;
    };
}

const patternsDir = path.join(__dirname, 'patterns/ecs-v1');

const doLoadDefaultSync = (loadModules) => {
    const result = new GrokCollection();
    // const files = fs.readdirSync(patternsDir);
    const files = readFilesSyncRecursively(patternsDir);
    //    console.log(files)
    //    process.exit();

    if (files && files.length) {
        files.filter(f => {
            return !loadModules || !loadModules.length || loadModules.indexOf(f.file) !== -1;
        }).forEach(f => {
            result.loadSync(path.join(f.path, f.file));
        });
    }

    return result;
};

const readFilesSyncRecursively = (dir) => {
    const results = [];
    const list = fs.readdirSync(dir);
    forEach(list, (file) => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            // Recurse into subdirectory
            results.push(...readFilesSyncRecursively(filePath));
        } else if (stat && stat.isFile()) {
            results.push({ path: dir, file });
        }
    });
    return results;
};

const readFilesAsyncRecursively = (patternDir, done) => {
    let results = [];
    fs.readdir(patternDir , { withFileTypes: true } , (err, files) => {
        if (err) {
            return done(err);
        }
        async.each(files,
            (file, callback) => {

                const fullPath = path.join(patternDir, file.name);
                if (file.isDirectory()) {
                    readFilesAsyncRecursively(fullPath, (err,res) => {
                        if (err) {
                            return callback(err);
                        }
                        results = results.concat(res);
                        callback()
                    })
                } else if (file.isFile()) {
                    results.push({ path: file.path, file : file.name })
                    callback()
                } else {
                    callback()
                }
            },
            err => {
                if (err) {
                    return done(err);
                }
                done(null, results);
            }
        )
    })
}

const doLoadDefault = ( loadModules, callback) => {
    readFilesAsyncRecursively(patternsDir, (err, allFiles) => {
        if (err) return callback(err);

        const result = new GrokCollection();

        const filesToLoad = allFiles.filter(f => {
            const base = f.path;
            return !loadModules || loadModules.length === 0 || loadModules.includes(base);
        });

        async.parallel(
            filesToLoad.map(f => {
                return cb => result.load(path.join(f.path , f.file), cb);
            }),
            err => {
                if (err) return callback(err);
                callback(null, result);
            }
        );
    });
};




module.exports = {
    loadDefault: fromCallback(function loadDefault(loadModules, callback) {
        if (arguments.length < 2) {
            callback = loadModules;
            loadModules = null;
        }

        doLoadDefault(loadModules, callback);
    }),
    loadDefaultSync: doLoadDefaultSync,
    GrokCollection: GrokCollection
};
