using UnityEngine;
using UnityEngine.AI;

namespace Prototeer.Unity
{
    internal sealed class PrototeerNavigation
    {
        private const float NavMeshSnapDistance = 0.2f;
        private const float StuckAfterSeconds = 5f;
        private readonly PrototeerBinding binding;
        private readonly NavMeshPath route = new();
        private NavMeshAgent agent;
        private object routeOwner;
        private int originalMask;
        private int routeMask;
        private bool originalAutoRepath;
        private bool originalStopped;
        private Vector3 endpoint;
        private float bestDistance;
        private double lastProgress;

        internal enum Result { Failure, Running, Success }

        internal PrototeerNavigation(PrototeerBinding binding) => this.binding = binding;

        internal bool TryGetQuery(bool forMovement, out NavMeshQueryFilter filter, out Vector3 start)
        {
            filter = default;
            start = default;
            if (agent == null)
                agent = binding.GetComponent<NavMeshAgent>();
            if (agent == null || !agent.isActiveAndEnabled || !agent.isOnNavMesh)
                return false;
            int mask = binding.MovementMask(routeOwner == null ? agent.areaMask : originalMask, forMovement);
            if (mask == 0)
                return false;

            filter.agentTypeID = agent.agentTypeID;
            filter.areaMask = mask;
            for (int area = 0; area < 32; area++)
            {
                if ((mask & (1 << area)) != 0)
                    filter.SetAreaCost(area, agent.GetAreaCost(area));
            }
            if (!NavMesh.SamplePosition(agent.nextPosition, out var hit, NavMeshSnapDistance, filter))
                return false;
            start = hit.position;
            return true;
        }

        internal static bool TryGetReachablePoint(Vector3 start, Vector3 target, NavMeshQueryFilter filter,
            NavMeshPath check, out Vector3 point)
        {
            point = default;
            if (!NavMesh.SamplePosition(target, out var hit, NavMeshSnapDistance, filter)
                || !NavMesh.CalculatePath(start, hit.position, filter, check)
                || check.status != NavMeshPathStatus.PathComplete)
                return false;
            point = hit.position;
            return true;
        }

        internal Result Begin(object owner, Vector3 destination)
        {
            if (!TryGetQuery(true, out var filter, out var start)
                || !TryGetReachablePoint(start, destination, filter, route, out var target))
                return Result.Failure;

            if (Vector3.Distance(start, target) <= agent.stoppingDistance + 0.035f)
            {
                Cancel();
                return Result.Success;
            }
            if (agent.speed <= 0 || !agent.updatePosition)
                return Result.Failure;

            Cancel();
            originalMask = agent.areaMask;
            originalAutoRepath = agent.autoRepath;
            originalStopped = agent.isStopped;
            routeOwner = owner;
            routeMask = filter.areaMask;
            endpoint = target;
            bestDistance = float.PositiveInfinity;
            lastProgress = Time.timeAsDouble;
            agent.areaMask = routeMask;
            agent.autoRepath = false;
            if (!agent.SetPath(route))
            {
                Cancel();
                return Result.Failure;
            }
            agent.isStopped = false;
            return Result.Running;
        }

        internal Result Update(object owner)
        {
            if (!ReferenceEquals(routeOwner, owner) || agent == null || !agent.isActiveAndEnabled
                || !agent.isOnNavMesh || agent.isStopped)
                return Result.Failure;

            // Never continue an old path when a bound zone or restriction changes.
            if (binding.MovementMask(originalMask, true) != routeMask || agent.areaMask != routeMask)
                return Result.Failure;
            if (Vector3.Distance(agent.nextPosition, endpoint) <= agent.stoppingDistance + 0.035f)
                return Result.Success;
            if (agent.pathPending)
                return Time.timeAsDouble - lastProgress < StuckAfterSeconds ? Result.Running : Result.Failure;
            if (!agent.hasPath || agent.isPathStale || agent.pathStatus != NavMeshPathStatus.PathComplete
                || Vector3.Distance(agent.destination, endpoint) > NavMeshSnapDistance)
                return Result.Failure;
            if (agent.remainingDistance < bestDistance - 0.015f)
            {
                bestDistance = agent.remainingDistance;
                lastProgress = Time.timeAsDouble;
            }
            return Time.timeAsDouble - lastProgress < StuckAfterSeconds ? Result.Running : Result.Failure;
        }

        internal void End(object owner)
        {
            if (ReferenceEquals(routeOwner, owner))
                Cancel();
        }

        internal void Cancel()
        {
            if (routeOwner == null)
                return;
            routeOwner = null;
            if (agent == null)
                return;
            if (agent.isActiveAndEnabled && agent.isOnNavMesh)
            {
                agent.isStopped = true;
                agent.velocity = Vector3.zero;
                agent.ResetPath();
                agent.isStopped = originalStopped;
            }
            agent.areaMask = originalMask;
            agent.autoRepath = originalAutoRepath;
        }
    }
}
