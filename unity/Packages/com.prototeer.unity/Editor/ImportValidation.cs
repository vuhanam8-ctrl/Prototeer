using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace Prototeer.Unity.Editor
{
    internal static class ImportValidation
    {
        private static readonly string[] RootFields =
            { "format", "formatVersion", "name", "stats", "tagDefs", "tools", "zones" };
        private static readonly string[] RuleTriggers = { "interact", "behavior", "tick", "contact" };
        private static readonly string[] RuleEffects = { "stat", "tag", "untag" };
        private static readonly string[] Comparisons = { "<", "<=", ">", ">=", "==", "!=" };

        internal static void Check(JObject world)
        {
            Require((string)world["format"] == "prototeer-unity"
                && world["formatVersion"]?.Type == JTokenType.Integer && (long)world["formatVersion"] == 1,
                "Unsupported export format. Download a new file using Export Unity.");
            Require(!world.Properties().Any(property => !RootFields.Contains(property.Name)),
                "Unknown data at the top level of the Unity export.");
            var stats = ReadIndex(ReadArray(world, "stats"), "stat");
            foreach (var stat in stats.Values)
            {
                var min = ReadNumber(stat, "min");
                var max = ReadNumber(stat, "max");
                var start = ReadNumber(stat, "start");
                Require(min < max && start >= min && start <= max, $"Invalid range for stat '{(string)stat["name"]}'.");
            }
            var tags = ReadIndex(ReadArray(world, "tagDefs"), "tag");
            var zones = ReadIndex(ReadArray(world, "zones"), "zone");
            var definitions = ReadIndex(ReadArray(world, "tools"), "object");
            Require(definitions.Count > 0, "Select at least one object type in Prototeer.");
            foreach (var definition in definitions.Values)
                CheckDefinition(definition, stats, tags, zones);
        }

        private static void CheckDefinition(JToken definition, Dictionary<string, JToken> stats,
            Dictionary<string, JToken> tags, Dictionary<string, JToken> zones)
        {
            var name = (string)definition["name"] ?? (string)definition["id"];
            Require(definition["brainEnabled"]?.Type == JTokenType.Boolean,
                $"'{name}' is missing the behavior enabled setting.");
            Require(definition["defaults"] is JObject, $"'{name}' is missing its starting stat values.");
            var ownedStats = ReadReferences(ReadArray(definition, "statIds"), stats, $"'{name}' stat");
            ReadReferences(ReadArray(definition, "tags"), tags, $"'{name}' tag");
            var allowed = ReadReferences(ReadArray(definition, "allowedMovementZones"), zones, $"'{name}' allowed zone");
            Require(allowed.All(id => (bool?)zones[id]["enabled"] != false), $"'{name}' references a disabled movement zone.");
            foreach (var attribute in ((JObject)definition["defaults"]).Properties())
            {
                Require(ownedStats.Contains(attribute.Name),
                    $"'{name}' sets a starting value for a stat it does not own.");
                var value = ReadNumber(definition["defaults"], attribute.Name);
                var stat = stats[attribute.Name];
                Require(value >= (double)stat["min"] && value <= (double)stat["max"],
                    $"'{name}' has an out-of-range starting stat.");
            }

            var rules = ReadIndex(ReadArray(definition, "rules"), "rule");
            foreach (var rule in rules.Values)
                CheckRule(name, rule, stats, tags);
            var brain = ReadArray(definition, "brain");
            var edges = ReadArray(definition, "edges");
            if (!(bool)definition["brainEnabled"])
                return;

            var nodes = ReadIndex(brain, "node");
            Require(nodes.Count is > 0 and <= 120 && nodes.ContainsKey("root"),
                $"'{name}' must have a behavior root and at most 120 nodes.");
            var visitedChildren = new HashSet<string>(StringComparer.Ordinal);
            var links = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (var pair in edges)
            {
                Require(pair is JArray edge && edge.Count == 2, $"'{name}' has a malformed behavior connection.");
                var from = (string)pair[0];
                var to = (string)pair[1];
                Require(!string.IsNullOrEmpty(from) && !string.IsNullOrEmpty(to) && nodes.ContainsKey(from)
                    && nodes.ContainsKey(to) && to != "root" && visitedChildren.Add(to),
                    $"'{name}' has an invalid or multiply connected behavior node.");
                if (!links.TryGetValue(from, out var outgoing))
                    links.Add(from, outgoing = new List<string>());
                outgoing.Add(to);
            }

            var visited = new HashSet<string>(StringComparer.Ordinal);
            Visit("root");
            Require(visited.Count == nodes.Count, $"'{name}' has behavior nodes disconnected from its root.");

            void Visit(string id)
            {
                var node = nodes[id];
                Require(visited.Add(id), $"'{name}' contains a behavior cycle.");
                links.TryGetValue(id, out var children);
                var label = $"'{name}' node '{(string)node["label"] ?? id}'";
                CheckNode(node, children, label, stats, tags, zones, rules, nodes);
                if (children == null)
                    return;
                foreach (var child in children)
                    Visit(child);
            }
        }

        private static void CheckRule(string name, JToken rule, Dictionary<string, JToken> stats,
            Dictionary<string, JToken> tags)
        {
            var label = $"'{name}' rule '{(string)rule["name"]}'";
            Require(rule["enabled"]?.Type == JTokenType.Boolean, $"{label} is missing its enabled setting.");
            if (!(bool)rule["enabled"])
                return;

            var condition = (string)rule["condition"];
            var effect = (string)rule["effect"];
            Require(RuleTriggers.Contains((string)rule["trigger"]) && RuleEffects.Contains(effect)
                && condition is "always" or "tag" or "stat", $"{label} uses a rule that Unity export does not support.");
            Require((string)rule["target"] is "self" or "other" && (string)rule["conditionTarget"] is "self" or "other",
                $"{label} has an invalid interaction target.");
            CheckOptionalReference(tags, (string)rule["selfTag"], $"{label} self tag");
            CheckOptionalReference(tags, (string)rule["otherTag"], $"{label} other tag");
            if (condition == "tag")
            {
                Require((string)rule["tagMode"] is "present" or "absent", $"{label} has an invalid tag check.");
                CheckReference(tags, (string)rule["conditionTag"], $"{label} condition tag");
            }
            if (condition == "stat")
            {
                Require(Comparisons.Contains((string)rule["op"]), $"{label} uses an unsupported stat comparison.");
                CheckReference(stats, (string)rule["stat"], $"{label} condition stat");
                ReadNumber(rule, "threshold");
            }
            if (effect == "stat")
            {
                CheckReference(stats, (string)rule["effectStat"], $"{label} effect stat");
                ReadNumber(rule, "amount");
            }
            else
            {
                CheckReference(tags, (string)rule["tag"], $"{label} effect tag");
            }
        }

        private static void CheckNode(JToken node, List<string> children, string label,
            Dictionary<string, JToken> stats, Dictionary<string, JToken> tags, Dictionary<string, JToken> zones,
            Dictionary<string, JToken> rules, Dictionary<string, JToken> nodes)
        {
            var kind = (string)node["type"];
            var composite = kind is "utility" or "selector" or "sequence";
            Require(composite == (children?.Count > 0),
                composite ? $"{label} needs at least one child." : $"{label} cannot have children.");
            switch (kind)
            {
                case "utility":
                    if (children != null)
                        foreach (var child in children.Select(id => nodes[id]))
                        {
                            var statId = (string)child["scoreStat"] ?? (string)child["stat"];
                            CheckOptionalReference(stats, statId, $"{label} utility score");
                            Require((string)child["direction"] is null or "low" or "high",
                                $"{label} has an invalid utility score direction.");
                            if (child["weight"] != null)
                                Require(ReadNumber(child, "weight") is >= 0 and <= 10,
                                    $"{label} has an invalid utility score weight.");
                            Require(string.IsNullOrEmpty((string)child["scoreZone"])
                                && string.IsNullOrEmpty((string)child["messageKey"]),
                                $"{label} can't use zone or director message scoring in Unity.");
                        }
                    return;
                case "selector":
                    return;
                case "sequence":
                    Require((string)node["sequenceMode"] == "memory",
                        $"{label} uses a reactive sequence. Unity export supports memory sequences.");
                    return;
                case "condition":
                    switch ((string)node["condition"])
                    {
                        case "stat":
                            CheckReference(stats, (string)node["stat"], $"{label} condition stat");
                            Require(Comparisons.Contains((string)node["op"]), $"{label} uses an unsupported stat comparison.");
                            ReadNumber(node, "threshold");
                            return;
                        case "tag":
                            Require((string)node["tagMode"] is "present" or "absent", $"{label} has an invalid tag check.");
                            CheckReference(tags, (string)node["tag"], $"{label} condition tag");
                            return;
                        default:
                            throw new InvalidDataException($"{label} uses a condition that Unity export does not support.");
                    }
                case "action":
                    break;
                default:
                    throw new InvalidDataException($"{label} has an unsupported node type.");
            }

            switch ((string)node["action"])
            {
                case "idle":
                    return;
                case "wait":
                    var min = ReadWaitTicks(node, "waitMin", 2);
                    var max = ReadWaitTicks(node, "waitMax", 6);
                    Require(max >= min, $"{label} has invalid wait limits.");
                    return;
                case "rule":
                    var id = (string)node["ruleId"];
                    Require(!string.IsNullOrEmpty(id) && rules.ContainsKey(id), $"{label} references an unavailable rule.");
                    return;
                case "chooseTarget":
                    Require(((string)node["selectionSource"] ?? "zones") == "zones"
                        && ((string)node["zoneRelation"] ?? "any") == "any"
                        && string.IsNullOrEmpty((string)node["originSlot"])
                        && ((int?)node["avoidRecent"] ?? 0) == 0,
                        $"{label} needs a plain zone-based destination for Unity export.");
                    var selected = ReadReferences(ReadArray(node, "selectionZones"), zones, $"{label} destination zone");
                    Require(selected.Count > 0 && selected.All(zone => (bool?)zones[zone]["enabled"] != false),
                        $"{label} needs at least one enabled destination zone.");
                    return;
                case "moveTarget":
                    Require(((string)node["routeStyle"] ?? "shortest") == "shortest" && (bool?)node["diagonal"] != true,
                        $"{label} uses board movement settings that don't carry over to Unity navigation.");
                    return;
                default:
                    throw new InvalidDataException($"{label} uses an action that Unity export does not support.");
            }
        }

        private static JArray ReadArray(JToken token, string field) =>
            token[field] as JArray ?? throw new InvalidDataException($"Unity export must include a '{field}' array.");

        private static Dictionary<string, JToken> ReadIndex(JArray items, string label)
        {
            var entries = new Dictionary<string, JToken>(StringComparer.Ordinal);
            foreach (var item in items)
            {
                var id = item is JObject ? (string)item["id"] : null;
                Require(!string.IsNullOrWhiteSpace(id) && id.Length <= 256 && entries.TryAdd(id, item),
                    $"Unity export has an invalid or duplicated {label} ID.");
            }
            return entries;
        }

        private static HashSet<string> ReadReferences(JArray list, Dictionary<string, JToken> entries, string name)
        {
            var values = new HashSet<string>(StringComparer.Ordinal);
            foreach (var token in list)
            {
                var id = (string)token;
                Require(!string.IsNullOrEmpty(id) && entries.ContainsKey(id) && values.Add(id),
                    $"Unity export has an invalid or duplicated {name} reference.");
            }
            return values;
        }

        private static void CheckOptionalReference(Dictionary<string, JToken> entries, string id, string name) =>
            Require(string.IsNullOrEmpty(id) || entries.ContainsKey(id), $"Unity export has an unknown {name} reference.");

        private static void CheckReference(Dictionary<string, JToken> entries, string id, string name) =>
            Require(!string.IsNullOrEmpty(id) && entries.ContainsKey(id), $"Unity export has an unknown {name} reference.");

        private static double ReadNumber(JToken token, string field)
        {
            var value = token[field];
            Require(value?.Type is JTokenType.Float or JTokenType.Integer, $"Unity export has a missing number in '{field}'.");
            var number = (double)value;
            Require(!double.IsNaN(number) && !double.IsInfinity(number), $"Unity export has a non-finite number in '{field}'.");
            return number;
        }

        private static long ReadWaitTicks(JToken node, string field, int fallback)
        {
            var value = node[field];
            if (value == null)
                return fallback;
            Require(value.Type == JTokenType.Integer && (long)value is >= 0 and <= 1000,
                $"Unity export has invalid wait limits in '{field}'.");
            return (long)value;
        }

        private static void Require(bool test, string error)
        {
            if (!test)
                throw new InvalidDataException(error);
        }
    }
}
