var Path = require("path");
var Dust = require("dustjs-linkedin");
var LoaderUtils = require("loader-utils");
var Async = require("async");
var FS = require("fs");

// Use the `paths` option to generate a template name based on the
// path of the .dust file.
//
// E.g. if paths is ["C:\MyApp\dust"] and resourcePath is
// "C:\MyApp\dust\home\widgets\welcome.dust" then the template name
// will be "home-widgets-welcome".
var uniqueNumber = 1;
var moduleMapping = {};

function getTemplateName(paths, resourcePath) {
    // We want to loop through each path and see if it matches part of the file path.
    for (var i = 0; i < paths.length; i++) {
        var path = paths[i];
        
        if (resourcePath.indexOf(path) == 0) {
            if (Path.basename(resourcePath) == "index.dust")
                resourcePath = Path.dirname(resourcePath);
            else
                resourcePath = resourcePath.replace(/\.dust$/i, "");

            return resourcePath
                .replace(path + Path.sep, "")
                // If the path includes slashes or spaces, replace them with hyphens.
                .replace(/[\\\/\s]+/g, "-");
        }
    }

    // If it's not in a known path, which means it's just not a partial, and
    // therefore doesn't need a name. (We just return "anonymous123", where
    // each .dust file gets a different number.)

    // Don't generate different template names for the same template.
    resourcePath = Path.resolve(resourcePath);
    if (resourcePath in moduleMapping)
        return moduleMapping[resourcePath];

    return moduleMapping[resourcePath] = "anonymousTemplate" + (uniqueNumber++);
}

function resolveDependency(ctx, dep, paths, callback) {
    if (dep.partialName) {
        resolvePartialName(dep.partialName, paths, callback);
    } else {
        ctx.resolve(ctx.context, dep.moduleName + ".dust", function(err, path) {
            if (err)
                return ctx.resolve(ctx.context, dep.moduleName + "/index.dust", callback);
                
            return callback(null, path);
        });
    }
}

function resolvePartialNameInPath(name, path, callback) {
    //console.log("Looking for", name, "in", path);

    if (name.length === 0)
        name = ["index"];
    
    var head = name[0],
        dustFile = Path.join.apply(Path, [path].concat(name)) + ".dust",
        subPath = Path.join(path, head);

    FS.exists(dustFile, function(hasDust) {
        // Found it!
        if (hasDust)
            return callback(null, dustFile);

        if (!head)
            return callback(null, false);
        
        FS.exists(subPath, function(folderExists) {
            // Found a matching folder! We must go deeper.
            if (folderExists) {
                return resolvePartialNameInPath(name.slice(1), subPath, callback);
            }

            // Not found. However, we might just need to try a longer path component.
            // E.g. framework-item-grading-list could be framework/item/grading-list
            // or framework-item/grading/list...
            if (name.length > 1) {
                var newName = name.slice(2);
                newName.unshift(name[0] + "-" + name[1]);
                //name = (name[0] + "-" + name[1]).concat(name.slice(2));
                return resolvePartialNameInPath(newName, path, callback);
            }

            // Not found, or possible to find.
            return callback(null, false);
        });
    });
}

function resolvePartialName(name, paths, callback) {
    if (typeof name === "string")
        return resolvePartialName(name.split(/-/), paths, callback);
    
    Async.eachSeries(paths, function(path, cb) {
        resolvePartialNameInPath(name, path, function(err, result) {
            if (err)
                return cb(err);

            // Found it (early return)
            if (result)
                return callback(null, result);

            // Try the next path
            return cb();
        });
    }, function(err) {
        if (err)
            return callback(err);

        // If we get here, we didn't find it.
        return callback(undefined);
    });
}

// Find {>".path/to/partial"/} references using a regular expression, and
// record where it was found (so that we can rewrite it later).
//
// This cannot possibly support interpolated template names, because the
// partial name isn't actually known until runtime.
//
// (A solution to this involving `require.context` is left as an exercise
// to the reader.)
function findDependencies(content) {
    var partials = [];
    var partialRegExp = /\{>\s*(?:([\w\d\-]+)|[^"]*"([^"]*)")/g;
    var match;

    while ((match = partialRegExp.exec(content))) {
        var partialName = match[1],
            moduleName = match[2];

        // Ignore interpolated template names, which have to use quotes
        if (moduleName && (moduleName.indexOf('{') > -1))
            continue;
        
        partials.push({
            partialName: partialName,
            moduleName: moduleName,
            index: match.index,
            length: match[0].length
        });
    }

    return partials;
}

// Replaces {>"./path/to/template"/} references with whatever the template's name
// should be (taking the `paths` option into account). 
function rewriteDependencies(content, deps) {
    var index = 0, // Current position in the content string
        chunks = [];

    deps.forEach(function(dep) {
        chunks.push(content.substring(index, dep.index));
        chunks.push('{>' + dep.newName);
        index = dep.index + dep.length;
    });

    if (index < content.length)
        chunks.push(content.substring(index));

    return chunks.join("");
}

// Generate some require statements, so that the partials get loaded when the template
// is required.
function getDependenciesJS(deps) {
    return deps.map(function(dep) {
        return "require(" + JSON.stringify(dep.rawPath) + ");";
    }).join("\n");
}

module.exports = function(content) {
    var query = LoaderUtils.parseQuery(this.query);
    
    this.cacheable && this.cacheable();

    // Resolving module references is asynchronous.
    var cb = this.async();

    // Partial paths
    var paths = [];
    if (query.path) 
        paths.push(query.path);

    if (query.paths)
        paths.push.apply(paths, query.paths);
    
    var deps = findDependencies(content);

    Async.eachSeries(deps, function(dep, callback) {
        resolveDependency(this, dep, paths, function(err, rawPath) {
            if (err)
                return callback(err);

            if (!rawPath)
                return callback(new Error("Unable to resolve dust partial: " + (dep.partialName || dep.moduleName)));

            if (query.verbose)
                console.log("Resolved", (dep.partialName || dep.moduleName), "to", rawPath);

            dep.rawPath = rawPath;
            this.addDependency(rawPath);

            var newName = getTemplateName(paths, rawPath);
            if (dep.partialName && dep.partialName != newName)
                return callback(new Error("Partial name doesn't resolve to itself: " + dep.partialName + " -> " + newName));
            dep.newName = newName;

            return callback();
        }.bind(this));
    }.bind(this), function(err) {
        if (err)
            return cb(err);
        
        content = rewriteDependencies(content, deps);
        var templateName = getTemplateName(paths, this.resourcePath);

        var compiled;
        try {
            compiled = Dust.compile(content, templateName);
        } catch(e) {
            return cb(e);
        }
        
        var output = [
            // The output of the compile function requires that the variable 'dust' exists. Without a module system, 'dust'
            // would exist on the window, making it a global variable.
            "var dust = require('dustjs-linkedin');\n",

            // Any require() statements for partials.
            getDependenciesJS(deps),
            
            // Compile the template returning an stringified IIFE registering the template under the name in 'templateName'.
            "\n" + compiled + "\n",
            
            // Return the template name to make the require statement more meaningful.
            "module.exports = " + JSON.stringify(templateName) + ";"
        ].join("");

        return cb(null, output);
    }.bind(this));
    
};
