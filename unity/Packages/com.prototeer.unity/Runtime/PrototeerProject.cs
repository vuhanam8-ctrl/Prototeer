using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Prototeer.Unity
{
    public sealed class PrototeerProject
    {
        private static readonly ConditionalWeakTable<TextAsset, PrototeerProject> Cache = new();

        internal readonly Dictionary<string, Stat> Stats;
        internal readonly Dictionary<string, string> Tags;
        internal readonly Dictionary<string, Definition> Definitions;
        internal readonly HashSet<string> Zones;
        private readonly NameLookup statNames;
        private readonly NameLookup tagNames;

        public string Name { get; }

        private PrototeerProject(TextAsset source)
        {
            var world = JObject.Parse(source.text);
            if ((string)world["format"] != "prototeer-unity" || (int?)world["formatVersion"] != 1)
                throw new InvalidDataException("Expected a Prototeer Unity export (format version 1).");

            Name = (string)world["name"] ?? source.name;
            Stats = Items(world, "stats").ToDictionary(RequiredId, node => new Stat(node), StringComparer.Ordinal);
            Tags = Items(world, "tagDefs").ToDictionary(RequiredId, node => (string)node["name"] ?? "", StringComparer.Ordinal);
            Zones = new HashSet<string>(Items(world, "zones").Select(RequiredId), StringComparer.Ordinal);
            Definitions = Items(world, "tools").ToDictionary(RequiredId,
                node => new Definition(node, this), StringComparer.Ordinal);
            statNames = new NameLookup(Stats.Select(pair => (pair.Key, pair.Value.Name)));
            tagNames = new NameLookup(Tags.Select(pair => (pair.Key, pair.Value)));
        }

        public static PrototeerProject Parse(TextAsset source)
        {
            if (source == null)
                throw new ArgumentNullException(nameof(source));
            return Cache.GetValue(source, asset => new PrototeerProject(asset));
        }

        public bool TryFindStatId(string idOrName, out string id) => statNames.TryResolve(idOrName, out id);
        public bool TryFindTagId(string idOrName, out string id) => tagNames.TryResolve(idOrName, out id);

        private static JEnumerable<JToken> Items(JToken value, string key) =>
            (value[key] as JArray ?? throw new InvalidDataException($"Missing {key} array.")).Children();

        private static string RequiredId(JToken node)
        {
            var id = (string)node["id"];
            return !string.IsNullOrWhiteSpace(id) ? id : throw new InvalidDataException("A definition is missing its ID.");
        }

        internal sealed class NameLookup
        {
            private readonly HashSet<string> ids = new(StringComparer.Ordinal);
            private readonly Dictionary<string, string> names = new(StringComparer.Ordinal);

            internal NameLookup(IEnumerable<(string Id, string Name)> pairs)
            {
                foreach (var (id, name) in pairs)
                {
                    ids.Add(id);
                    if (string.IsNullOrEmpty(name))
                        continue;
                    if (names.ContainsKey(name))
                        names[name] = null;
                    else
                        names.Add(name, id);
                }
            }

            internal bool TryResolve(string idOrName, out string id)
            {
                id = null;
                if (string.IsNullOrEmpty(idOrName))
                    return false;
                if (!ids.Contains(idOrName))
                    return names.TryGetValue(idOrName, out id) && id != null;
                id = idOrName;
                return true;
            }
        }

        internal sealed class Stat
        {
            internal readonly string Name;
            internal readonly double Min;
            internal readonly double Max;
            internal readonly double Start;

            internal Stat(JToken node)
            {
                Name = (string)node["name"] ?? "";
                Min = (double)node["min"];
                Max = (double)node["max"];
                var start = (double)node["start"];
                if (!double.IsFinite(Min) || !double.IsFinite(Max) || !double.IsFinite(start) || Min >= Max)
                    throw new InvalidDataException("A stat needs finite bounds with maximum greater than minimum.");
                Start = Math.Clamp(start, Min, Max);
            }
        }

        internal sealed class Definition
        {
            internal readonly bool Mobile;
            internal readonly string[] Tags;
            internal readonly string[] MovementZones;
            internal readonly Dictionary<string, double> StartingStats;
            internal readonly Rule[] Rules;
            internal readonly NameLookup RuleNames;

            internal Definition(JToken node, PrototeerProject project)
            {
                Tags = Items(node, "tags").Values<string>().ToArray();
                MovementZones = Items(node, "allowedMovementZones").Values<string>().ToArray();
                Mobile = (bool?)node["mobile"] ?? false;
                if (Tags.Any(id => id == null || !project.Tags.ContainsKey(id))
                    || MovementZones.Any(id => id == null || !project.Zones.Contains(id)))
                    throw new InvalidDataException("An object type references a missing tag or zone.");

                StartingStats = new Dictionary<string, double>(StringComparer.Ordinal);
                foreach (var id in Items(node, "statIds").Values<string>())
                {
                    if (id == null || !project.Stats.TryGetValue(id, out var stat))
                        throw new InvalidDataException("An object type references a missing stat.");
                    var start = (double?)node["defaults"]?[id] ?? stat.Start;
                    if (!double.IsFinite(start))
                        throw new InvalidDataException("A starting stat value must be finite.");
                    StartingStats.Add(id, Math.Clamp(start, stat.Min, stat.Max));
                }

                Rules = Items(node, "rules").Select(rule => new Rule(rule, project)).ToArray();
                RuleNames = new NameLookup(Rules.Select(rule => (rule.Id, rule.Name)));
            }
        }

        internal sealed class Rule
        {
            internal readonly string Id, Name, Trigger, SelfTag, OtherTag, Condition, ConditionTag, StatId,
                Operator, Effect, EffectStat, Tag;
            internal readonly bool Enabled, TestOther, TargetOther, TagPresent;
            internal readonly double Threshold, Amount;

            internal Rule(JToken node, PrototeerProject project)
            {
                Id = RequiredId(node);
                Name = (string)node["name"] ?? "";
                Enabled = (bool?)node["enabled"] ?? false;
                Trigger = (string)node["trigger"] ?? "";
                SelfTag = (string)node["selfTag"] ?? "";
                OtherTag = (string)node["otherTag"] ?? "";
                Condition = (string)node["condition"] ?? "always";
                TestOther = (string)node["conditionTarget"] == "other";
                ConditionTag = (string)node["conditionTag"] ?? "";
                TagPresent = (string)node["tagMode"] != "absent";
                StatId = (string)node["stat"] ?? "";
                Operator = (string)node["op"] ?? ">=";
                Threshold = (double?)node["threshold"] ?? 0;
                TargetOther = (string)node["target"] == "other";
                Effect = (string)node["effect"] ?? "";
                EffectStat = (string)node["effectStat"] ?? "";
                Amount = (double?)node["amount"] ?? 0;
                Tag = (string)node["tag"] ?? "";

                if (!Enabled)
                    return;
                if (Trigger is not ("interact" or "behavior" or "contact" or "tick")
                    || Condition is not ("always" or "tag" or "stat")
                    || Effect is not ("stat" or "tag" or "untag"))
                    throw new InvalidDataException($"Unsupported rule '{Name}'.");
                if ((!string.IsNullOrEmpty(SelfTag) && !project.Tags.ContainsKey(SelfTag))
                    || (!string.IsNullOrEmpty(OtherTag) && !project.Tags.ContainsKey(OtherTag))
                    || (Condition == "tag" && !project.Tags.ContainsKey(ConditionTag))
                    || (Effect != "stat" && !project.Tags.ContainsKey(Tag))
                    || (Condition == "stat" && (!project.Stats.ContainsKey(StatId)
                        || !IsComparison(Operator) || !double.IsFinite(Threshold)))
                    || (Effect == "stat" && (!project.Stats.ContainsKey(EffectStat) || !double.IsFinite(Amount))))
                    throw new InvalidDataException($"Invalid stat or tag in rule '{Name}'.");
            }
        }

        internal static bool IsComparison(string operation) =>
            operation is "<" or "<=" or ">" or ">=" or "==" or "!=";

        internal static bool Compare(double left, string operation, double right) => operation switch
        {
            "<" => left < right,
            "<=" => left <= right,
            ">" => left > right,
            ">=" => left >= right,
            "==" => left == right,
            "!=" => left != right,
            _ => false,
        };
    }
}
