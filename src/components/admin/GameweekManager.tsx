import React, { useState, useEffect } from 'react';
import { Play, Lock, CheckCircle, Calendar, Users, Trophy, AlertTriangle, RefreshCw, Database } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import toast from 'react-hot-toast';

interface Gameweek {
  gameweek_id: number;
  gameweek_number: number;
  start_date: string;
  end_date: string;
  status: 'upcoming' | 'active' | 'locked' | 'finalized';
  created_at: string;
  is_current?: boolean;
  is_next?: boolean;
  deadline_time?: string;
  start_time?: string;
  end_time?: string;
  name?: string;
  is_finished?: boolean;
}

interface GameweekStats {
  total_matches: number;
  completed_matches: number;
  total_teams: number;
  calculated_teams: number;
}

export default function GameweekManager() {
  const [gameweeks, setGameweeks] = useState<Gameweek[]>([]);
  const [selectedGameweek, setSelectedGameweek] = useState<number | null>(null);
  const [gameweekStats, setGameweekStats] = useState<GameweekStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initializeGameweeks();
  }, []);

  useEffect(() => {
    if (selectedGameweek) {
      fetchGameweekStats(selectedGameweek);
    }
  }, [selectedGameweek]);

  const initializeGameweeks = async () => {
    setLoading(true);
    setError(null);
    
    try {
      // First, update gameweek status
      await updateGameweekStatus();
      
      // Then fetch the gameweeks
      await fetchGameweeks();
    } catch (error) {
      console.error('Error initializing gameweeks:', error);
      setError('Failed to initialize gameweek system. Please check your database connection.');
    } finally {
      setLoading(false);
    }
  };

  const updateGameweekStatus = async () => {
    try {
      // Update existing gameweeks with missing columns if needed
      const { error: updateError } = await supabase.rpc('update_gameweek_status');
      if (updateError) {
        console.warn('Update gameweek status warning:', updateError);
        // Don't throw error, just log warning as this might be expected
      }
    } catch (error) {
      console.warn('Warning updating gameweek status:', error);
      // Don't throw error, continue with fetching
    }
  };

  const fetchGameweeks = async () => {
    try {
      const { data, error } = await supabase
        .from('gameweeks')
        .select('*')
        .order('gameweek_number');

      if (error) throw error;
      
      setGameweeks(data || []);
      
      // Auto-select first non-finalized gameweek or current active one
      if (data && data.length > 0 && !selectedGameweek) {
        const activeGW = data.find(gw => gw.status === 'active') || 
                        data.find(gw => gw.status !== 'finalized') || 
                        data[0];
        setSelectedGameweek(activeGW.gameweek_number);
      }
    } catch (error) {
      console.error('Error fetching gameweeks:', error);
      throw new Error('Failed to fetch gameweeks');
    }
  };

  const fetchGameweekStats = async (gameweek: number) => {
    try {
      // Get match stats
      const { data: matches, error: matchError } = await supabase
        .from('real_matches')
        .select('status')
        .eq('gameweek', gameweek);

      if (matchError) throw matchError;

      // Get team stats
      const { data: teams, error: teamError } = await supabase
        .from('fantasy_teams')
        .select('fantasy_team_id');

      if (teamError) throw teamError;

      // Get calculated teams for this gameweek
      const { data: calculatedTeams, error: calcError } = await supabase
        .from('fantasy_team_gameweek_points')
        .select('fantasy_team_id')
        .eq('gameweek', gameweek);

      if (calcError) throw calcError;

      setGameweekStats({
        total_matches: matches?.length || 0,
        completed_matches: matches?.filter(m => m.status === 'completed').length || 0,
        total_teams: teams?.length || 0,
        calculated_teams: calculatedTeams?.length || 0,
      });
    } catch (error) {
      console.error('Error fetching gameweek stats:', error);
    }
  };

  const setGameweekStatus = async (gameweek: number, status: string) => {
    setProcessing(true);
    try {
      const { error } = await supabase
        .from('gameweeks')
        .update({ 
          status: status,
          is_current: status === 'active',
          is_next: false
        })
        .eq('gameweek_number', gameweek);

      if (error) throw error;

      // Update other gameweeks if setting this one as active
      if (status === 'active') {
        await supabase
          .from('gameweeks')
          .update({ is_current: false })
          .neq('gameweek_number', gameweek);

        // Set next gameweek
        await supabase
          .from('gameweeks')
          .update({ is_next: true })
          .eq('gameweek_number', gameweek + 1);
      }
      
      toast.success(`Gameweek ${gameweek} status set to ${status}`);
      await fetchGameweeks();
      if (selectedGameweek === gameweek) {
        await fetchGameweekStats(gameweek);
      }
    } catch (error) {
      console.error('Error setting gameweek status:', error);
      toast.error('Failed to update gameweek status');
    } finally {
      setProcessing(false);
    }
  };

  const finalizeGameweek = async (gameweek: number) => {
    if (!confirm(`Are you sure you want to finalize Gameweek ${gameweek}? This will calculate all team points and cannot be undone.`)) {
      return;
    }

    setProcessing(true);
    try {
      // Check if finalize_gameweek function exists, if not use manual calculation
      try {
        const { error } = await supabase.rpc('finalize_gameweek', {
          p_gameweek: gameweek
        });

        if (error) throw error;
      } catch (rpcError) {
        console.warn('RPC function not available, using manual calculation:', rpcError);
        
        // Manual finalization process
        await calculateAllTeamPoints(gameweek);
        
        // Update gameweek status
        await supabase
          .from('gameweeks')
          .update({ 
            status: 'finalized',
            is_finished: true,
            is_current: false
          })
          .eq('gameweek_number', gameweek);

        // Set next gameweek as current if it exists
        const nextGameweek = gameweeks.find(gw => gw.gameweek_number === gameweek + 1);
        if (nextGameweek) {
          await supabase
            .from('gameweeks')
            .update({ 
              is_current: true,
              is_next: false,
              status: 'active'
            })
            .eq('gameweek_number', gameweek + 1);
        }
      }
      
      toast.success(`Gameweek ${gameweek} finalized successfully!`);
      await fetchGameweeks();
      await fetchGameweekStats(gameweek);
    } catch (error) {
      console.error('Error finalizing gameweek:', error);
      toast.error('Failed to finalize gameweek: ' + (error.message || 'Unknown error'));
    } finally {
      setProcessing(false);
    }
  };

  const calculateAllTeamPoints = async (gameweek: number) => {
    // Get all fantasy teams
    const { data: teams, error: teamsError } = await supabase
      .from('fantasy_teams')
      .select('fantasy_team_id');

    if (teamsError) throw teamsError;

    let calculatedCount = 0;
    
    // Calculate points for each team
    for (const team of teams || []) {
      try {
        const teamPoints = await calculateTeamPointsManual(team.fantasy_team_id, gameweek);
        
        // Insert or update gameweek points
        const { error: insertError } = await supabase
          .from('fantasy_team_gameweek_points')
          .upsert({
            fantasy_team_id: team.fantasy_team_id,
            gameweek: gameweek,
            points: teamPoints || 0
          });

        if (!insertError) {
          calculatedCount++;
        }
      } catch (error) {
        console.error('Error calculating points for team:', team.fantasy_team_id, error);
        continue;
      }
    }

    return calculatedCount;
  };

  const calculateTeamPointsManual = async (fantasyTeamId: string, gameweek: number) => {
    // Get team roster with player scores
    const { data: roster, error } = await supabase
      .from('rosters')
      .select(`
        *,
        players:player_id (
          position
        )
      `)
      .eq('fantasy_team_id', fantasyTeamId);

    if (error) throw error;

    let totalPoints = 0;
    let captainPoints = 0;

    for (const rosterPlayer of roster || []) {
      if (!rosterPlayer.is_starter) continue;

      // Get player's gameweek score
      const { data: scores } = await supabase
        .from('gameweek_scores')
        .select('total_points, minutes_played')
        .eq('player_id', rosterPlayer.player_id)
        .eq('gameweek', gameweek)
        .single();

      const playerPoints = scores?.total_points || 0;
      const minutesPlayed = scores?.minutes_played || 0;

      // If player didn't play, try to substitute
      if (minutesPlayed === 0) {
        // Find substitute from bench with same position
        const substitute = roster.find(r => 
          !r.is_starter && 
          r.players?.position === rosterPlayer.players?.position
        );

        if (substitute) {
          const { data: subScores } = await supabase
            .from('gameweek_scores')
            .select('total_points, minutes_played')
            .eq('player_id', substitute.player_id)
            .eq('gameweek', gameweek)
            .single();

          const subPoints = subScores?.total_points || 0;
          const subMinutes = subScores?.minutes_played || 0;

          if (subMinutes > 0) {
            totalPoints += subPoints;
            if (rosterPlayer.is_captain) {
              captainPoints = subPoints;
            }
          }
        }
      } else {
        totalPoints += playerPoints;
        if (rosterPlayer.is_captain) {
          captainPoints = playerPoints;
        }
      }
    }

    // Apply captain multiplier
    totalPoints += captainPoints;

    return totalPoints;
  };

  const calculateExistingPoints = async (gameweek: number) => {
    if (!confirm(`Calculate points for existing Gameweek ${gameweek} data? This will process all completed matches.`)) {
      return;
    }

    setProcessing(true);
    try {
      const calculatedCount = await calculateAllTeamPoints(gameweek);
      toast.success(`Calculated points for ${calculatedCount} teams in Gameweek ${gameweek}`);
      await fetchGameweekStats(gameweek);
    } catch (error) {
      console.error('Error calculating existing points:', error);
      toast.error('Failed to calculate points');
    } finally {
      setProcessing(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'upcoming': return 'bg-blue-100 text-blue-800';
      case 'active': return 'bg-green-100 text-green-800';
      case 'locked': return 'bg-yellow-100 text-yellow-800';
      case 'finalized': return 'bg-gray-100 text-gray-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'upcoming': return <Calendar className="h-4 w-4" />;
      case 'active': return <Play className="h-4 w-4" />;
      case 'locked': return <Lock className="h-4 w-4" />;
      case 'finalized': return <CheckCircle className="h-4 w-4" />;
      default: return <Calendar className="h-4 w-4" />;
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-6">
        <div className="text-center">
          <AlertTriangle className="h-12 w-12 text-red-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">System Error</h3>
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={initializeGameweeks}
            className="bg-emerald-600 text-white px-4 py-2 rounded-lg hover:bg-emerald-700 transition-colors"
          >
            Retry Initialization
          </button>
        </div>
      </div>
    );
  }

  const selectedGW = gameweeks.find(gw => gw.gameweek_number === selectedGameweek);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm p-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Gameweek Management</h1>
            <p className="text-gray-600">
              Control gameweek flow, calculate points, and finalize results.
            </p>
          </div>
          <div className="flex space-x-3">
            <button
              onClick={() => updateGameweekStatus().then(() => fetchGameweeks())}
              disabled={processing}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${processing ? 'animate-spin' : ''}`} />
              Refresh Status
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Gameweek List */}
        <div className="lg:col-span-1">
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Gameweeks ({gameweeks.length})</h2>
            {gameweeks.length === 0 ? (
              <div className="text-center py-8">
                <Calendar className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                <p className="text-gray-500 text-sm">No gameweeks found</p>
                <p className="text-gray-400 text-xs mt-1">Check your gameweeks table</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {gameweeks.map((gameweek) => (
                  <button
                    key={gameweek.gameweek_id}
                    onClick={() => setSelectedGameweek(gameweek.gameweek_number)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selectedGameweek === gameweek.gameweek_number
                        ? 'border-emerald-500 bg-emerald-50'
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium text-gray-900">
                          Gameweek {gameweek.gameweek_number}
                        </div>
                        <div className="text-sm text-gray-500">
                          {new Date(gameweek.start_date).toLocaleDateString()} - {new Date(gameweek.end_date).toLocaleDateString()}
                        </div>
                      </div>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(gameweek.status)}`}>
                        {getStatusIcon(gameweek.status)}
                        <span className="ml-1">{gameweek.status}</span>
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Gameweek Details */}
        <div className="lg:col-span-2">
          {selectedGW ? (
            <div className="space-y-6">
              {/* Status Card */}
              <div className="bg-white rounded-xl shadow-sm p-6">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h2 className="text-2xl font-bold text-gray-900">
                      Gameweek {selectedGW.gameweek_number}
                    </h2>
                    <p className="text-gray-600">
                      {new Date(selectedGW.start_date).toLocaleDateString()} - {new Date(selectedGW.end_date).toLocaleDateString()}
                    </p>
                  </div>
                  <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(selectedGW.status)}`}>
                    {getStatusIcon(selectedGW.status)}
                    <span className="ml-2">{selectedGW.status}</span>
                  </span>
                </div>

                {/* Stats */}
                {gameweekStats && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    <div className="bg-blue-50 p-4 rounded-lg">
                      <div className="flex items-center">
                        <Calendar className="h-5 w-5 text-blue-600 mr-2" />
                        <div>
                          <p className="text-sm text-blue-600">Matches</p>
                          <p className="text-lg font-semibold text-blue-900">
                            {gameweekStats.completed_matches}/{gameweekStats.total_matches}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="bg-emerald-50 p-4 rounded-lg">
                      <div className="flex items-center">
                        <Users className="h-5 w-5 text-emerald-600 mr-2" />
                        <div>
                          <p className="text-sm text-emerald-600">Teams</p>
                          <p className="text-lg font-semibold text-emerald-900">
                            {gameweekStats.calculated_teams}/{gameweekStats.total_teams}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="bg-purple-50 p-4 rounded-lg">
                      <div className="flex items-center">
                        <Trophy className="h-5 w-5 text-purple-600 mr-2" />
                        <div>
                          <p className="text-sm text-purple-600">Progress</p>
                          <p className="text-lg font-semibold text-purple-900">
                            {gameweekStats.total_matches > 0 
                              ? Math.round((gameweekStats.completed_matches / gameweekStats.total_matches) * 100)
                              : 0
                            }%
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="bg-orange-50 p-4 rounded-lg">
                      <div className="flex items-center">
                        <CheckCircle className="h-5 w-5 text-orange-600 mr-2" />
                        <div>
                          <p className="text-sm text-orange-600">Calculated</p>
                          <p className="text-lg font-semibold text-orange-900">
                            {gameweekStats.total_teams > 0 
                              ? Math.round((gameweekStats.calculated_teams / gameweekStats.total_teams) * 100)
                              : 0
                            }%
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex flex-wrap gap-3">
                  {selectedGW.status === 'upcoming' && (
                    <button
                      onClick={() => setGameweekStatus(selectedGW.gameweek_number, 'active')}
                      disabled={processing}
                      className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors flex items-center"
                    >
                      <Play className="h-4 w-4 mr-2" />
                      Start Gameweek
                    </button>
                  )}

                  {selectedGW.status === 'active' && (
                    <button
                      onClick={() => setGameweekStatus(selectedGW.gameweek_number, 'locked')}
                      disabled={processing}
                      className="bg-yellow-600 text-white px-4 py-2 rounded-lg hover:bg-yellow-700 disabled:opacity-50 transition-colors flex items-center"
                    >
                      <Lock className="h-4 w-4 mr-2" />
                      Lock Transfers
                    </button>
                  )}

                  {gameweekStats && gameweekStats.completed_matches > 0 && gameweekStats.calculated_teams < gameweekStats.total_teams && (
                    <button
                      onClick={() => calculateExistingPoints(selectedGW.gameweek_number)}
                      disabled={processing}
                      className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center"
                    >
                      <Database className="h-4 w-4 mr-2" />
                      Calculate Points
                    </button>
                  )}

                  {(selectedGW.status === 'locked' || selectedGW.status === 'active') && 
                   gameweekStats && 
                   gameweekStats.completed_matches === gameweekStats.total_matches && (
                    <button
                      onClick={() => finalizeGameweek(selectedGW.gameweek_number)}
                      disabled={processing}
                      className="bg-emerald-600 text-white px-4 py-2 rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors flex items-center"
                    >
                      <CheckCircle className="h-4 w-4 mr-2" />
                      Finalize Gameweek
                    </button>
                  )}

                  {selectedGW.status !== 'finalized' && (
                    <button
                      onClick={() => setGameweekStatus(selectedGW.gameweek_number, 'upcoming')}
                      disabled={processing}
                      className="bg-gray-600 text-white px-4 py-2 rounded-lg hover:bg-gray-700 disabled:opacity-50 transition-colors"
                    >
                      Reset to Upcoming
                    </button>
                  )}
                </div>

                {/* Warnings and Info */}
                <div className="mt-4 space-y-2">
                  {gameweekStats && gameweekStats.completed_matches < gameweekStats.total_matches && (
                    <div className="flex items-center text-yellow-600 bg-yellow-50 p-3 rounded-lg">
                      <AlertTriangle className="h-4 w-4 mr-2" />
                      <span className="text-sm">
                        {gameweekStats.total_matches - gameweekStats.completed_matches} matches still pending completion
                      </span>
                    </div>
                  )}

                  {selectedGW.status === 'finalized' && (
                    <div className="flex items-center text-green-600 bg-green-50 p-3 rounded-lg">
                      <CheckCircle className="h-4 w-4 mr-2" />
                      <span className="text-sm">
                        Gameweek finalized - all team points calculated and ranks updated
                      </span>
                    </div>
                  )}

                  {gameweekStats && gameweekStats.completed_matches > 0 && gameweekStats.calculated_teams === 0 && (
                    <div className="flex items-center text-blue-600 bg-blue-50 p-3 rounded-lg">
                      <Database className="h-4 w-4 mr-2" />
                      <span className="text-sm">
                        Completed matches found but no points calculated yet. Click "Calculate Points" to process existing data.
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-xl shadow-sm p-6 text-center">
              <Calendar className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">Select a Gameweek</h3>
              <p className="text-gray-500">Choose a gameweek from the list to manage its status and calculate points.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}