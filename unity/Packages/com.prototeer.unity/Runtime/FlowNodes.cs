using System;
using System.Collections.Generic;
using System.Reflection;
using Newtonsoft.Json;
using Unity.Behavior;
using Unity.Properties;
using UnityEngine;

namespace Prototeer.Unity
{
    [Serializable, GeneratePropertyBag]
    [NodeDescription(name: "Prototeer Tick", category: "Flow/Prototeer",
        description: "Restarts the tree on a new simulation tick.",
        id: "a35a5004ef524a119a405a4c96b34f4c")]
    public sealed partial class ClockNode : Modifier
    {
        private long lastStart = -1;

        protected override Status OnStart() => Pulse();
        protected override Status OnUpdate() => Pulse();

        private Status Pulse()
        {
            if (Child == null || !GameObject.TryGetComponent<PrototeerBinding>(out var binding) || !binding.isActiveAndEnabled)
                return Status.Failure;
            var tick = binding.Tick;
            if (Child.CurrentStatus is not (Status.Running or Status.Waiting) && tick != lastStart)
            {
                lastStart = tick;
                StartNode(Child);
            }
            return Status.Running;
        }

        protected override void OnEnd() => lastStart = -1;
    }

    // Unity owns child lifetimes. A decision composite can keep observing a native child
    // that is waiting on an animation or route while its own OnUpdate checks priorities.
    [Serializable, GeneratePropertyBag]
    public abstract partial class DecisionNode : Composite
    {
        private Node active;
        private int lastFrame = -1;

        protected Node Active => active;

        protected override Status OnStart() => Poll();
        protected override Status OnUpdate() => Poll();

        private Status Poll()
        {
            if (lastFrame == Time.frameCount)
                return Status.Running;
            lastFrame = Time.frameCount;
            if (!GameObject.TryGetComponent<PrototeerBinding>(out var binding) || !binding.isActiveAndEnabled)
                return Finish(Status.Failure);
            return Decide(binding);
        }

        protected abstract Status Decide(PrototeerBinding binding);

        protected Status Visit(Node branch)
        {
            bool wasActive = branch == active;
            var status = wasActive ? branch.CurrentStatus : StartNode(branch);
            if (status is not (Status.Success or Status.Running or Status.Waiting))
            {
                if (wasActive)
                    active = null;
                return Status.Failure;
            }

            if (!wasActive && active != null && active.CurrentStatus is Status.Running or Status.Waiting)
                EndNode(active);
            active = status == Status.Success ? null : branch;
            return status == Status.Success ? Status.Success : Status.Running;
        }

        protected Status Finish(Status status)
        {
            if (active != null && active.CurrentStatus is Status.Running or Status.Waiting)
                EndNode(active);
            active = null;
            return status;
        }

        protected override void OnEnd()
        {
            // Unity ends the running descendants before closing this composite.
            active = null;
            Ended();
        }

        protected virtual void Ended() { }
    }

    [Serializable, GeneratePropertyBag]
    [NodeDescription(name: "Prototeer Selector", category: "Flow/Prototeer",
        description: "Try the children in order, including while another is running.",
        id: "3d3220ca7d85401ab0085d041f9266da")]
    public sealed partial class SelectorNode : DecisionNode
    {
        protected override Status Decide(PrototeerBinding binding)
        {
            foreach (var child in Children)
            {
                var result = Visit(child);
                if (result != Status.Failure)
                    return result;
            }
            return Finish(Status.Failure);
        }
    }

    [Serializable, GeneratePropertyBag]
    [NodeDescription(name: "Prototeer Utility", category: "Flow/Prototeer",
        description: "Score each branch and try them in order from highest to lowest.",
        id: "8af03f8258af49b5aa1667405fd55bbc")]
    public sealed partial class UtilityNode : DecisionNode
    {
        private static readonly FieldInfo NodeId = typeof(Node).GetField("ID", BindingFlags.Instance | BindingFlags.NonPublic);
        [SerializeReference] public BlackboardVariable<bool> Commit = new(false);
        [SerializeReference] public BlackboardVariable<int> CommitTicks = new(120);
        [SerializeReference] public BlackboardVariable<double> InterruptMargin = new(1);
        [SerializeReference] public BlackboardVariable<string> ScoresJson = new("[]");

        private string loadedScores;
        private ScoreSetting[] settings = Array.Empty<ScoreSetting>();
        private Node[] loadedChildren = Array.Empty<Node>();
        private int[] order = Array.Empty<int>();
        private double[] scores = Array.Empty<double>();
        private Node committed;
        private double committedScore;
        private long committedUntil;

        protected override Status Decide(PrototeerBinding binding)
        {
            if (!TryLoadSettings())
                return Finish(Status.Failure);

            int count = Rank(binding);
            int held = GetHeldIndex(binding.Tick, count);
            if (held > 0)
            {
                int index = order[held];
                Array.Copy(order, 0, order, 1, held);
                order[0] = index;
            }

            for (int i = 0; i < count; i++)
            {
                int index = order[i];
                var child = Children[index];
                var result = Visit(child);
                if (result == Status.Failure)
                    continue;
                if (result == Status.Running && Commit.Value)
                {
                    if (committed != child)
                        committedScore = scores[index];
                    if (committed != child || committedUntil <= binding.Tick)
                        committedUntil = binding.Tick + Math.Max(1, CommitTicks.Value);
                    committed = child;
                }
                else
                {
                    committed = null;
                }
                return result;
            }
            return Finish(Status.Failure);
        }

        private int Rank(PrototeerBinding binding)
        {
            int count = 0;
            for (int i = 0; i < settings.Length; i++)
            {
                var score = settings[i].GetScore(binding);
                scores[i] = score;
                if (!double.IsFinite(score) || score < 0)
                    continue;
                int position = count++;
                while (position > 0 && score > scores[order[position - 1]])
                {
                    order[position] = order[position - 1];
                    position--;
                }
                order[position] = i;
            }
            return count;
        }

        private int GetHeldIndex(long tick, int count)
        {
            if (!Commit.Value || committed == null || Active == null || tick >= committedUntil || count == 0)
                return -1;
            for (int i = 0; i < count; i++)
            {
                if (Children[order[i]] != committed)
                    continue;
                return i == 0 || scores[order[0]] <= committedScore + InterruptMargin.Value ? i : -1;
            }
            return -1;
        }

        private bool TryLoadSettings()
        {
            var json = ScoresJson.Value ?? "[]";
            if (loadedScores == json && HasSameChildren())
                return settings.Length == Children.Count;

            loadedScores = json;
            loadedChildren = Children.ToArray();
            settings = Array.Empty<ScoreSetting>();
            ScoreSetting[] configured;
            try
            {
                configured = JsonConvert.DeserializeObject<ScoreSetting[]>(json) ?? Array.Empty<ScoreSetting>();
            }
            catch (JsonException)
            {
                return false;
            }

            var byNode = new Dictionary<string, ScoreSetting>(StringComparer.Ordinal);
            foreach (var setting in configured)
            {
                if (setting == null || string.IsNullOrEmpty(setting.Node) || !byNode.TryAdd(setting.Node, setting))
                    return false;
            }

            if (NodeId == null)
                return false;
            var ordered = new ScoreSetting[loadedChildren.Length];
            var defaultSetting = new ScoreSetting();
            for (int i = 0; i < ordered.Length; i++)
            {
                var id = NodeId.GetValue(loadedChildren[i])?.ToString();
                if (string.IsNullOrEmpty(id))
                    return false;
                ordered[i] = byNode.TryGetValue(id, out var setting) ? setting : defaultSetting;
            }
            settings = ordered;
            order = new int[settings.Length];
            scores = new double[settings.Length];
            return true;
        }

        private bool HasSameChildren()
        {
            if (Children.Count != loadedChildren.Length)
                return false;
            for (int i = 0; i < loadedChildren.Length; i++)
                if (!ReferenceEquals(Children[i], loadedChildren[i]))
                    return false;
            return true;
        }

        protected override void Ended() => committed = null;

        private sealed class ScoreSetting
        {
            [JsonProperty("node")] public string Node { get; set; }
            [JsonProperty("stat")] public string Stat { get; set; }
            [JsonProperty("direction")] public string Direction { get; set; }
            [JsonProperty("weight")] public double Weight { get; set; } = 1;

            public double GetScore(PrototeerBinding binding)
            {
                if (string.IsNullOrEmpty(Stat))
                    return Weight;
                if (!binding.TryReadStat(Stat, out var value, out var min, out var max))
                    return -1;
                var ratio = Math.Clamp((value - min) / (max - min), 0, 1);
                return (Direction == "low" ? 1 - ratio : ratio) * Weight;
            }
        }
    }

    [Serializable, GeneratePropertyBag]
    [NodeDescription(name: "Prototeer Sequence", category: "Flow/Prototeer",
        description: "Run the children in order, remembering the running step.",
        id: "3153a648b1af4ee3b052117eb59b810e")]
    public sealed partial class SequenceNode : Composite
    {
        [SerializeReference] public BlackboardVariable<bool> ResetOnInterrupt = new(true);

        private int index;
        private bool remember;
        private long lastTick;

        protected override Status OnStart()
        {
            if (!GameObject.TryGetComponent<PrototeerBinding>(out var binding) || Children.Count == 0)
                return Status.Failure;
            if (!remember || (ResetOnInterrupt.Value && lastTick < binding.Tick - 1))
                index = 0;
            return StartPending(binding.Tick);
        }

        protected override Status OnUpdate()
        {
            var binding = GameObject.GetComponent<PrototeerBinding>();
            lastTick = binding.Tick;
            return Children[index].CurrentStatus switch
            {
                Status.Success => Next(binding.Tick),
                Status.Running or Status.Waiting => Status.Running,
                _ => Complete(Status.Failure),
            };
        }

        private Status Next(long tick)
        {
            index++;
            return StartPending(tick);
        }

        private Status StartPending(long tick)
        {
            lastTick = tick;
            while (index < Children.Count)
            {
                var result = StartNode(Children[index]);
                if (result is Status.Running or Status.Waiting)
                {
                    remember = true;
                    return Status.Running;
                }
                if (result != Status.Success)
                    return Complete(Status.Failure);
                index++;
            }
            return Complete(Status.Success);
        }

        private Status Complete(Status status)
        {
            remember = false;
            index = 0;
            return status;
        }

        protected override void OnEnd()
        {
            if (CurrentStatus != Status.Interrupted)
                Complete(Status.Failure);
        }
    }
}
