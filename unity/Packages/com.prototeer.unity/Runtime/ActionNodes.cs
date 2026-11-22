using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Unity.Behavior;
using Unity.Properties;
using UnityEngine;
using UnityEngine.AI;
using BehaviorAction = Unity.Behavior.Action;

namespace Prototeer.Unity
{
    [Serializable, GeneratePropertyBag]
    [NodeDescription(name: "Prototeer Idle", category: "Action/Prototeer",
        id: "09086229187e477fa2c07d0418209061")]
    public sealed partial class IdleNode : BehaviorAction
    {
        protected override Status OnStart() => Status.Success;
    }

    [Serializable, GeneratePropertyBag]
    [NodeDescription(name: "Prototeer Wait", story: "Wait [Minimum]–[Maximum] simulation ticks",
        category: "Action/Prototeer", id: "b877c97df7dc4f21b4fe9e6c40e5836e")]
    public sealed partial class WaitNode : BehaviorAction
    {
        [SerializeReference] public BlackboardVariable<int> Minimum = new(2);
        [SerializeReference] public BlackboardVariable<int> Maximum = new(6);
        [SerializeReference] public BlackboardVariable<bool> ResetOnInterrupt = new(true);

        private long deadline = -1;
        private long lastTick;
        private PrototeerBinding binding;

        protected override Status OnStart()
        {
            if (!GameObject.TryGetComponent(out binding) || !binding.isActiveAndEnabled)
                return Status.Failure;
            var tick = binding.Tick;
            if (ResetOnInterrupt.Value && lastTick < tick - 1)
                deadline = -1;
            if (deadline < 0)
            {
                int min = Minimum.Value;
                int max = Maximum.Value;
                if (min < 0 || max < min || max > 1000)
                    return Status.Failure;
                deadline = tick + min + binding.NextIndex(max - min + 1);
            }
            return OnUpdate();
        }

        protected override Status OnUpdate()
        {
            if (binding == null || !binding.isActiveAndEnabled)
                return Status.Failure;
            lastTick = binding.Tick;
            if (lastTick < deadline)
                return Status.Running;
            deadline = -1;
            return Status.Success;
        }
    }

    [Serializable, GeneratePropertyBag]
    [NodeDescription(name: "Prototeer Condition", story: "Check [Kind] condition",
        category: "Action/Prototeer", id: "f9c3d64f9bdc4667924c10e9752b225b")]
    public sealed partial class ConditionNode : BehaviorAction
    {
        [SerializeReference] public BlackboardVariable<string> Kind = new("stat");
        [SerializeReference] public BlackboardVariable<string> TagId = new("");
        [SerializeReference] public BlackboardVariable<bool> TagPresent = new(true);
        [SerializeReference] public BlackboardVariable<string> StatId = new("");
        [SerializeReference] public BlackboardVariable<string> Operator = new(">=");
        [SerializeReference] public BlackboardVariable<double> Threshold = new(0);

        protected override Status OnStart()
        {
            if (!GameObject.TryGetComponent<PrototeerBinding>(out var binding) || !binding.isActiveAndEnabled)
                return Status.Failure;
            bool matched = Kind.Value switch
            {
                "stat" => binding.MatchesCondition(StatId.Value, Operator.Value, Threshold.Value),
                "tag" => binding.MatchesTagCondition(TagId.Value, TagPresent.Value),
                _ => false,
            };
            return matched ? Status.Success : Status.Failure;
        }
    }

    [Serializable, GeneratePropertyBag]
    [NodeDescription(name: "Run Prototeer Rule", story: "Run [RuleName]",
        category: "Action/Prototeer", id: "b2ae06bb40b443798bf41c30e43fa3346")]
    public sealed partial class RuleNode : BehaviorAction
    {
        [SerializeReference] public BlackboardVariable<string> RuleId = new("");
        [SerializeReference] public BlackboardVariable<string> RuleName = new("");
        [SerializeReference] public BlackboardVariable<bool> NoopSuccess = new(false);

        protected override Status OnStart()
        {
            if (!GameObject.TryGetComponent<PrototeerBinding>(out var binding) || !binding.isActiveAndEnabled)
                return Status.Failure;
            return binding.TryRunBehaviorRule(RuleId.Value, NoopSuccess.Value) ? Status.Success : Status.Failure;
        }
    }

    [Serializable, GeneratePropertyBag]
    [NodeDescription(name: "Choose Prototeer Point", story: "Choose in [ZoneNames] and store in [Slot]",
        category: "Action/Prototeer", id: "aefdd8f83d4a4dbea31805acacb14a8c")]
    public sealed partial class ChoosePointNode : BehaviorAction
    {
        [SerializeReference] public BlackboardVariable<string> ZoneIdsJson = new("[]");
        [SerializeReference] public BlackboardVariable<string> ZoneNames = new("");
        [SerializeReference] public BlackboardVariable<string> Slot = new("destination");
        [SerializeReference] public BlackboardVariable<float> MinimumTravel = new(0);
        [SerializeReference] public BlackboardVariable<bool> KeepTarget = new(false);

        private string loadedZones;
        private string[] zoneIds = Array.Empty<string>();
        private NavMeshPath path;
        private readonly HashSet<Vector3> seen = new();
        private readonly List<List<Vector3>> reachable = new();
        private readonly List<List<Vector3>> distant = new();

        protected override Status OnStart()
        {
            if (!GameObject.TryGetComponent<PrototeerBinding>(out var binding) || !binding.isActiveAndEnabled
                || !binding.Navigation.TryGetQuery(false, out var filter, out var start)
                || string.IsNullOrEmpty(Slot.Value))
                return Status.Failure;
            path ??= new NavMeshPath();
            if (KeepTarget.Value && binding.TryReadDestination(Slot.Value, out var saved))
                return PrototeerNavigation.TryGetReachablePoint(start, saved, filter, path, out _)
                    ? Status.Success : Status.Failure;
            RefreshZones();

            seen.Clear();
            reachable.Clear();
            distant.Clear();
            var minimumTravel = Mathf.Max(0, MinimumTravel.Value);
            foreach (var id in zoneIds)
            {
                if (!binding.TryFindSceneZone(id, out var zone))
                    return Status.Failure;
                AddCandidates(zone, filter, start, minimumTravel);
            }
            var groups = distant.Count > 0 ? distant : reachable;
            if (groups.Count == 0)
                return Status.Failure;
            var candidates = groups[binding.NextIndex(groups.Count)];
            return binding.TryStoreDestination(Slot.Value, candidates[binding.NextIndex(candidates.Count)])
                ? Status.Success : Status.Failure;
        }

        private void RefreshZones()
        {
            var json = ZoneIdsJson.Value ?? "[]";
            if (loadedZones == json)
                return;
            loadedZones = json;
            try { zoneIds = JsonConvert.DeserializeObject<string[]>(json) ?? Array.Empty<string>(); }
            catch (JsonException) { zoneIds = Array.Empty<string>(); }
        }

        private void AddCandidates(PrototeerZone zone, NavMeshQueryFilter filter, Vector3 start, float minimumTravel)
        {
            List<Vector3> zonePoints = null;
            List<Vector3> distantPoints = null;
            foreach (var marker in zone.Markers)
            {
                if (marker == null || !marker.gameObject.activeInHierarchy
                    || !PrototeerNavigation.TryGetReachablePoint(start, marker.position, filter, path, out var point)
                    || !seen.Add(point))
                    continue;
                (zonePoints ??= new List<Vector3>()).Add(point);
                if (Vector3.Distance(start, point) >= minimumTravel)
                    (distantPoints ??= new List<Vector3>()).Add(point);
            }
            if (zonePoints != null)
                reachable.Add(zonePoints);
            if (distantPoints != null)
                distant.Add(distantPoints);
        }
    }

    [Serializable, GeneratePropertyBag]
    [NodeDescription(name: "Unity Route to Prototeer Point", story: "Navigate to the point stored in [Slot]",
        category: "Action/Prototeer", id: "729bf97246d848d9a165ebc28489ac879")]
    public sealed partial class MoveToPointNode : BehaviorAction
    {
        [SerializeReference] public BlackboardVariable<string> Slot = new("destination");

        private PrototeerNavigation navigation;

        protected override Status OnStart()
        {
            if (!GameObject.TryGetComponent<PrototeerBinding>(out var binding) || !binding.isActiveAndEnabled
                || !binding.TryReadDestination(Slot.Value, out var destination))
                return Status.Failure;
            navigation = binding.Navigation;
            return Translate(navigation.Begin(this, destination));
        }

        protected override Status OnUpdate() =>
            navigation == null ? Status.Failure : Translate(navigation.Update(this));

        protected override void OnEnd()
        {
            navigation?.End(this);
            navigation = null;
        }

        private static Status Translate(PrototeerNavigation.Result result) => result switch
        {
            PrototeerNavigation.Result.Running => Status.Running,
            PrototeerNavigation.Result.Success => Status.Success,
            _ => Status.Failure,
        };
    }
}
