var Path = require("path");
var Dust = require("dustjs-linkedin");
var LoaderUtils = require("loader-utils");
var Async = require("Async");

// Use the `paths` option to generate a template name based on the
// path of the .dust file.
//
// E.g. if paths is ["C:\MyApp\dust"] and resourcePath is
// "C:\MyApp\dust\home\widgets\welcome.dust" then the template name
// will be "home-widgets-welcome".
function getTemplateName(paths, resourcePath) {
    // We want to loop through each path and see if it matches part of the file path.
    for (var i = 0; i < paths.length; i ++) {
        var path = paths[i];
        
        if (resourcePath.indexOf(path) == 0) {
            if (Path.basename(resourcePath) == "index.dust") {
                resourcePath = Path.dirname(resourcePath);
            } else {
                resourcePath = resourcePath.replace(/\.dust$/i, "");
            }
            
            return resourcePath
                .replace(path + Path.sep, "")
                // If the path includes slashes or spaces, replace them with hyphens.
                .replace(/[/\\\s]/g, "-");
        }
    }

    // XXX what to do here?
    // If it's not in a known path, does that mean it's just not a partial, and
    // therefore doesn't need a name? (E.g. we could just return "anonymous123"
    // as long as each .dust file gets a different number?)
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
    var partialRegExp = /\{>\s*[^"]*"([^"]*)"/g;
    var match;

    while ((match = partialRegExp.exec(content))) {
        var name = match[1];

        // Ignore interpolated template names
        if (name.indexOf('{') > -1)
            continue;
        
        partials.push({
            name: name,
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
        chunks.push(content.substr(index, dep.index));
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
        return "require(" + JSON.stringify(dep.rawPath) + ")";
    }).join(";\n");
}

module.exports = function(content) {
    var query = LoaderUtils.parseQuery(this.query);
    var paths = [];
    
    this.cacheable && this.cacheable();

    // Resolving module references is asynchronous.
    var cb = this.async();
    
    if (query.path) 
        paths.push(query.path);

    if (query.paths)
        paths.push.apply(paths, query.paths);
    
    paths.push(this.options.context);

    var deps = findDependencies(content);

    Async.eachSeries(deps, function(dep, callback) {
        this.resolve(this.context, dep.name + ".dust", function(err, rawPath) {
            if (err)
                return callback(err);

            dep.rawPath = rawPath;
            this.addDependency(rawPath);
            dep.newName = getTemplateName(paths, rawPath);

            return callback();
        }.bind(this));
    }.bind(this), function(err) {
        if (err)
            return cb(err);
        
        content = rewriteDependencies(content, deps);
        var templateName = getTemplateName(paths, this.resourcePath);

        var output = [
            // The output of the compile function requires that the variable 'dust' exists. Without a module system, 'dust'
            // would exist on the window, making it a global variable.
            "var dust = require('dustjs-linkedin');\n",

            // Any require() statements for partials.
            getDependenciesJS(deps),
            
            // Compile the template returning an stringified IIFE registering the template under the name in 'templateName'.
            Dust.compile(content, templateName) + "\n",
            
            // Return the template name to make the require statement more meaningful.
            "module.exports = " + JSON.stringify(templateName) + ";"
        ].join("");

        return cb(null, output);
    }.bind(this));
    
};
