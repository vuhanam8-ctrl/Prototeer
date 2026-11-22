using System;
using System.Collections.Generic;
using UnityEngine;

namespace Prototeer.Unity
{
    [DisallowMultipleComponent]
    [AddComponentMenu("Prototeer/Mechanics")]
    public sealed class PrototeerBinding : MonoBehaviour
    {
        [SerializeField] private TextAsset source;
        [SerializeField] private string definitionId;
        [SerializeField, Tooltip("Bind the exported zone IDs to zones in this scene.")]
        private PrototeerZone[] sceneZones = Array.Empty<PrototeerZone>();
        [SerializeField, Min(1), Tooltip("Simulation ticks per second for waits and utility commitment.")]
        private float ticksPerSecond = 10;

        private readonly HashSet<string> tags = new(StringComparer.Ordinal);
        private readonly Dictionary<string, double> stats = new(StringComparer.Ordinal);
        private readonly Dictionary<string, Vector3> destinations = new(StringComparer.Ordinal);
        private PrototeerProject project;
        private PrototeerProject.Definition definition;
        private PrototeerNavigation navigation;
        private TextAsset loadedSource;
        private string loadedId;
        private System.Random random;

        public TextAsset Source => source;
        public string DefinitionId => definitionId;
        internal long Tick => (long)(Time.timeAsDouble * Math.Max(1, ticksPerSecond));
        internal PrototeerNavigation Navigation => navigation ??= new PrototeerNavigation(this);
        internal int NextIndex(int count) => (random ??= new System.Random(GetEntityId().GetHashCode())).Next(count);

        public void Configure(TextAsset mechanics, string id)
        {
            var parsed = PrototeerProject.Parse(mechanics);
            if (string.IsNullOrEmpty(id) || !parsed.Definitions.ContainsKey(id))
                throw new ArgumentException("Object type is missing from the Prototeer export.", nameof(id));
            navigation?.Cancel();
            source = mechanics;
            definitionId = id;
            loadedSource = null;
            EnsureReady();
        }

        public void ConfigureZones(PrototeerZone[] zones)
        {
            navigation?.Cancel();
            sceneZones = zones != null ? (PrototeerZone[])zones.Clone() : Array.Empty<PrototeerZone>();
        }

        public void ConfigureClock(float tickRate)
        {
            if (!float.IsFinite(tickRate) || tickRate < 1)
                throw new ArgumentOutOfRangeException(nameof(tickRate));
            ticksPerSecond = tickRate;
        }

        public bool HasTag(string idOrName) =>
            EnsureReady() && project.TryFindTagId(idOrName, out var id) && tags.Contains(id);

        public bool TryGetStat(string idOrName, out double value)
        {
            value = 0;
            return EnsureReady() && project.TryFindStatId(idOrName, out var id) && stats.TryGetValue(id, out value);
        }

        public bool TrySetStat(string idOrName, double value) =>
            double.IsFinite(value) && EnsureReady() && project.TryFindStatId(idOrName, out var id)
            && TryWriteStat(id, value, out _);

        public bool Invoke(string trigger, GameObject other = null, string ruleId = null) =>
            InvokeRules(trigger, other, ruleId);

        public bool InvokeRule(string idOrName, GameObject other = null) =>
            EnsureReady() && definition.RuleNames.TryResolve(idOrName, out var id)
            && InvokeRules(null, other, id);

        private bool EnsureReady()
        {
            if (source == null || string.IsNullOrEmpty(definitionId))
                return false;
            if (loadedSource == source && loadedId == definitionId)
                return definition != null;

            loadedSource = source;
            loadedId = definitionId;
            definition = null;
            stats.Clear();
            tags.Clear();
            destinations.Clear();
            try
            {
                project = PrototeerProject.Parse(source);
                if (!project.Definitions.TryGetValue(definitionId, out definition))
                    return false;
            }
            catch (Exception error) when (error is Newtonsoft.Json.JsonException
                or System.IO.InvalidDataException or ArgumentException or InvalidOperationException)
            {
                Debug.LogError($"Prototeer could not load '{source.name}': {error.Message}", this);
                return false;
            }

            foreach (var pair in definition.StartingStats)
                stats.Add(pair.Key, pair.Value);
            tags.UnionWith(definition.Tags);
            return true;
        }

        private bool InvokeRules(string trigger, GameObject other, string ruleId)
        {
            if (!EnsureReady() || (trigger == null && ruleId == null))
                return false;
            var targetBinding = other == null ? null : other.GetComponent<PrototeerBinding>();
            if (targetBinding != null && (!targetBinding.EnsureReady() || !ReferenceEquals(project, targetBinding.project)))
                targetBinding = null;
            var changed = false;
            foreach (var rule in definition.Rules)
            {
                if (!rule.Enabled || (trigger != null && rule.Trigger != trigger)
                    || (ruleId != null && rule.Id != ruleId)
                    || !MatchesTag(this, rule.SelfTag) || !MatchesTag(targetBinding, rule.OtherTag))
                    continue;
                var subject = rule.TestOther ? targetBinding : this;
                var target = rule.TargetOther ? targetBinding : this;
                if (target != null && MatchesCondition(subject, rule))
                    changed |= Apply(target, rule);
            }
            return changed;
        }

        private static bool MatchesTag(PrototeerBinding subject, string id) =>
            string.IsNullOrEmpty(id) || (subject != null && subject.tags.Contains(id));

        private static bool MatchesCondition(PrototeerBinding subject, PrototeerProject.Rule rule) =>
            rule.Condition switch
            {
                "always" => true,
                "tag" => subject != null && (subject.tags.Contains(rule.ConditionTag) == rule.TagPresent),
                "stat" => subject != null && subject.stats.TryGetValue(rule.StatId, out var value)
                    && PrototeerProject.Compare(value, rule.Operator, rule.Threshold),
                _ => false,
            };

        private static bool Apply(PrototeerBinding target, PrototeerProject.Rule rule) => rule.Effect switch
        {
            "stat" => target.stats.TryGetValue(rule.EffectStat, out var value)
                && target.TryWriteStat(rule.EffectStat, value + rule.Amount, out var changed) && changed,
            "tag" => target.tags.Count < 30 && target.tags.Add(rule.Tag),
            "untag" => target.tags.Remove(rule.Tag),
            _ => false,
        };

        private bool TryWriteStat(string id, double value, out bool changed)
        {
            changed = false;
            if (!stats.TryGetValue(id, out var previous))
                return false;
            var stat = project.Stats[id];
            var next = Math.Clamp(value, stat.Min, stat.Max);
            changed = next != previous;
            stats[id] = next;
            return true;
        }

        internal bool TryReadStat(string id, out double value, out double min, out double max)
        {
            value = min = max = 0;
            if (!EnsureReady() || string.IsNullOrEmpty(id) || !stats.TryGetValue(id, out value))
                return false;
            var stat = project.Stats[id];
            min = stat.Min;
            max = stat.Max;
            return true;
        }

        internal bool MatchesCondition(string statId, string comparison, double threshold) =>
            TryReadStat(statId, out var value, out _, out _) && PrototeerProject.Compare(value, comparison, threshold);

        internal bool MatchesTagCondition(string id, bool expected) =>
            EnsureReady() && !string.IsNullOrEmpty(id) && project.Tags.ContainsKey(id)
            && tags.Contains(id) == expected;

        internal bool TryRunBehaviorRule(string id, bool noopSuccess) =>
            EnsureReady() && !string.IsNullOrEmpty(id) && Array.Exists(definition.Rules, rule => rule.Id == id)
            && (InvokeRules("behavior", null, id) || noopSuccess);

        internal bool TryFindSceneZone(string id, out PrototeerZone zone)
        {
            zone = null;
            if (!EnsureReady() || string.IsNullOrEmpty(id) || !project.Zones.Contains(id))
                return false;
            foreach (var item in sceneZones ?? Array.Empty<PrototeerZone>())
            {
                if (item == null || !item.isActiveAndEnabled || item.ZoneId != id)
                    continue;
                if (zone != null)
                    return false;
                zone = item;
            }
            return zone != null;
        }

        internal int MovementMask(int defaultMask, bool requireMobile)
        {
            if (!EnsureReady() || (requireMobile && !definition.Mobile))
                return 0;
            if (definition.MovementZones.Length == 0)
                return defaultMask;
            var union = 0;
            foreach (var id in definition.MovementZones)
            {
                if (!TryFindSceneZone(id, out var zone))
                    return 0;
                union |= zone.AreaMask;
            }
            return defaultMask & union;
        }

        internal bool TryReadDestination(string slot, out Vector3 point)
        {
            point = default;
            return !string.IsNullOrEmpty(slot) && destinations.TryGetValue(slot, out point);
        }

        internal bool TryStoreDestination(string slot, Vector3 point)
        {
            if (string.IsNullOrEmpty(slot) || (destinations.Count >= 20 && !destinations.ContainsKey(slot)))
                return false;
            destinations[slot] = point;
            return true;
        }

        private void OnDisable() => navigation?.Cancel();
    }
}
